use once_cell::sync::Lazy;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

fn db_path(app: &AppHandle) -> PathBuf {
  app
    .path()
    .app_data_dir()
    .unwrap_or_else(|_| PathBuf::from("."))
    .join("floor-pos.sqlite")
}

fn open_db(app: &AppHandle) -> Result<(), String> {
  let path = db_path(app);
  if let Some(dir) = path.parent() {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  let conn = Connection::open(path).map_err(|e| e.to_string())?;
  conn
    .execute_batch(
      "
      create table if not exists units (
        sku text primary key,
        title text not null,
        brand text,
        model text,
        category text,
        condition text,
        ask_cents integer,
        state text not null
      );
      create table if not exists outbox (
        id text primary key,
        sku text not null,
        price_cents integer not null,
        tax_cents integer not null,
        actor_id text not null,
        client_sale_id text not null,
        created_at text not null,
        receipt_payload text not null,
        status text not null,
        receipt_no text,
        error text
      );
      create table if not exists incidents (
        id text primary key,
        sku text not null,
        message text not null,
        created_at text not null
      );
      create table if not exists kv (
        key text primary key,
        value text not null
      );
      ",
    )
    .map_err(|e| e.to_string())?;
  *DB.lock().map_err(|e| e.to_string())? = Some(conn);
  Ok(())
}

fn with_db<T>(f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
  let mut guard = DB.lock().map_err(|e| e.to_string())?;
  let conn = guard.as_mut().ok_or_else(|| "db not open".to_string())?;
  f(conn)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CachedUnit {
  sku: String,
  title: String,
  brand: Option<String>,
  model: Option<String>,
  category: Option<String>,
  condition: Option<String>,
  ask_cents: Option<i64>,
  state: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OutboxRow {
  id: String,
  sku: String,
  price_cents: i64,
  tax_cents: i64,
  actor_id: String,
  client_sale_id: String,
  created_at: String,
  receipt_payload: String,
  status: String,
  receipt_no: Option<String>,
  error: Option<String>,
}

fn default_paper_kind() -> String {
  "letter".into()
}

fn default_legal() -> String {
  "7-DAY EXCHANGE ONLY. No returns and no refunds. With this receipt, you may exchange the item or take store credit within 7 days of sale. Goods are sold AS-IS, WHERE-IS, with all faults, whether or not noted at sale. Floor is not the manufacturer and does not provide manufacturer warranty service unless a remaining OEM warranty still applies to that serial. Keep this receipt.".into()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PosSettings {
  #[serde(default = "default_paper_kind")]
  paper_kind: String,
  chars_per_line: Option<i64>,
  #[serde(default)]
  printer_path: String,
  #[serde(default)]
  review_url: String,
  #[serde(default = "default_legal")]
  receipt_legal: String,
  #[serde(default)]
  terminal_device_id: String,
  #[serde(default)]
  tax_rate_bps: i64,
}

fn default_settings() -> PosSettings {
  PosSettings {
    paper_kind: default_paper_kind(),
    chars_per_line: None,
    printer_path: "".into(),
    review_url: "".into(),
    receipt_legal: default_legal(),
    terminal_device_id: "".into(),
    tax_rate_bps: 0,
  }
}

#[tauri::command]
fn cache_replace_units(units: Vec<CachedUnit>) -> Result<(), String> {
  with_db(|conn| {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("delete from units", []).map_err(|e| e.to_string())?;
    {
      let mut stmt = tx
        .prepare(
          "insert into units (sku, title, brand, model, category, condition, ask_cents, state)
           values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .map_err(|e| e.to_string())?;
      for u in units {
        stmt
          .execute(params![
            u.sku,
            u.title,
            u.brand,
            u.model,
            u.category,
            u.condition,
            u.ask_cents,
            u.state
          ])
          .map_err(|e| e.to_string())?;
      }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
  })
}

#[tauri::command]
fn search_units(query: String) -> Result<Vec<CachedUnit>, String> {
  with_db(|conn| {
    let q = query.trim().to_lowercase();
    let mut stmt = conn
      .prepare(
        "select sku, title, brand, model, category, condition, ask_cents, state
         from units where state = 'available' order by sku desc",
      )
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([], |row| {
        Ok(CachedUnit {
          sku: row.get(0)?,
          title: row.get(1)?,
          brand: row.get(2)?,
          model: row.get(3)?,
          category: row.get(4)?,
          condition: row.get(5)?,
          ask_cents: row.get(6)?,
          state: row.get(7)?,
        })
      })
      .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
      let u = row.map_err(|e| e.to_string())?;
      if q.is_empty()
        || u.sku.to_lowercase().contains(&q)
        || u.title.to_lowercase().contains(&q)
        || u.brand.clone().unwrap_or_default().to_lowercase().contains(&q)
        || u.model.clone().unwrap_or_default().to_lowercase().contains(&q)
        || u.category.clone().unwrap_or_default().to_lowercase().contains(&q)
      {
        out.push(u);
      }
    }
    Ok(out)
  })
}

#[tauri::command]
fn outbox_insert(row: OutboxRow) -> Result<(), String> {
  with_db(|conn| {
    conn
      .execute(
        "insert into outbox (id, sku, price_cents, tax_cents, actor_id, client_sale_id, created_at, receipt_payload, status, receipt_no, error)
         values (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
          row.id,
          row.sku,
          row.price_cents,
          row.tax_cents,
          row.actor_id,
          row.client_sale_id,
          row.created_at,
          row.receipt_payload,
          row.status,
          row.receipt_no,
          row.error
        ],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  })
}

#[tauri::command]
fn outbox_pending() -> Result<Vec<OutboxRow>, String> {
  with_db(|conn| {
    let mut stmt = conn
      .prepare(
        "select id, sku, price_cents, tax_cents, actor_id, client_sale_id, created_at, receipt_payload, status, receipt_no, error
         from outbox where status = 'pending' order by created_at",
      )
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([], |row| {
        Ok(OutboxRow {
          id: row.get(0)?,
          sku: row.get(1)?,
          price_cents: row.get(2)?,
          tax_cents: row.get(3)?,
          actor_id: row.get(4)?,
          client_sale_id: row.get(5)?,
          created_at: row.get(6)?,
          receipt_payload: row.get(7)?,
          status: row.get(8)?,
          receipt_no: row.get(9)?,
          error: row.get(10)?,
        })
      })
      .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
  })
}

#[tauri::command]
fn outbox_update(id: String, status: String, receipt_no: Option<String>, error: Option<String>) -> Result<(), String> {
  with_db(|conn| {
    conn
      .execute(
        "update outbox set status = ?1, receipt_no = coalesce(?2, receipt_no), error = ?3 where id = ?4",
        params![status, receipt_no, error, id],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  })
}

#[tauri::command]
fn incident_insert(id: String, sku: String, message: String) -> Result<(), String> {
  with_db(|conn| {
    conn
      .execute(
        "insert into incidents (id, sku, message, created_at) values (?1, ?2, ?3, datetime('now'))",
        params![id, sku, message],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  })
}

#[tauri::command]
fn incidents_list() -> Result<Vec<serde_json::Value>, String> {
  with_db(|conn| {
    let mut stmt = conn
      .prepare("select id, sku, message, created_at from incidents order by created_at desc")
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([], |row| {
        Ok(serde_json::json!({
          "id": row.get::<_, String>(0)?,
          "sku": row.get::<_, String>(1)?,
          "message": row.get::<_, String>(2)?,
          "createdAt": row.get::<_, String>(3)?,
        }))
      })
      .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
  })
}

#[tauri::command]
fn settings_get() -> Result<PosSettings, String> {
  with_db(|conn| {
    let raw: Result<String, _> = conn.query_row("select value from kv where key = 'settings'", [], |row| row.get(0));
    match raw {
      Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
      Err(_) => Ok(default_settings()),
    }
  })
}

#[tauri::command]
fn settings_set(settings: PosSettings) -> Result<(), String> {
  with_db(|conn| {
    let text = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    conn
      .execute(
        "insert into kv(key, value) values('settings', ?1)
         on conflict(key) do update set value = excluded.value",
        params![text],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  })
}

fn cups_default_printer() -> Option<String> {
  let out = Command::new("lpstat").arg("-d").output().ok()?;
  let text = String::from_utf8_lossy(&out.stdout);
  for line in text.lines() {
    if let Some(rest) = line.strip_prefix("system default destination:") {
      let name = rest.trim();
      if !name.is_empty() {
        return Some(name.to_string());
      }
    }
  }
  None
}

fn cups_has_any_printer() -> bool {
  let out = match Command::new("lpstat").arg("-p").output() {
    Ok(o) => o,
    Err(_) => return false,
  };
  if !out.status.success() && out.stdout.is_empty() {
    return false;
  }
  let text = String::from_utf8_lossy(&out.stdout);
  text.lines().any(|l| l.starts_with("printer "))
}

fn cups_printer_offline(queue: &str) -> Option<bool> {
  let out = Command::new("lpstat").args(["-p", queue]).output().ok()?;
  let text = String::from_utf8_lossy(&out.stdout);
  let lower = text.to_lowercase();
  if lower.contains("is idle") || lower.contains("is printing") || lower.contains("enabled") {
    if lower.contains("disabled") || lower.contains("offline") || lower.contains("paused") {
      return Some(true);
    }
    return Some(false);
  }
  if lower.contains("disabled") || lower.contains("offline") || lower.contains("paused") {
    return Some(true);
  }
  if text.trim().is_empty() {
    let a = Command::new("lpstat").arg("-a").output().ok()?;
    let atext = String::from_utf8_lossy(&a.stdout);
    if !atext.lines().any(|l| l.starts_with(queue) || l.starts_with(&format!("{queue} "))) {
      return None;
    }
  }
  None
}

fn list_cups_printers() -> Vec<serde_json::Value> {
  let out = match Command::new("lpstat").arg("-p").output() {
    Ok(o) => o,
    Err(_) => return vec![],
  };
  let text = String::from_utf8_lossy(&out.stdout);
  let mut printers = Vec::new();
  for line in text.lines() {
    let Some(rest) = line.strip_prefix("printer ") else {
      continue;
    };
    let name = rest.split_whitespace().next().unwrap_or("").to_string();
    if name.is_empty() {
      continue;
    }
    let lower = line.to_lowercase();
    let status = if lower.contains("disabled") || lower.contains("offline") {
      "offline"
    } else if lower.contains("idle") {
      "idle"
    } else if lower.contains("printing") {
      "printing"
    } else {
      "unknown"
    };
    printers.push(serde_json::json!({ "name": name, "status": status }));
  }
  printers
}

/// WinAnsi can't encode the receipt's typography (bullets, middots, dashes,
/// smart quotes), so transliterate to something Courier/WinAnsi renders.
/// Latin-1 bytes go out as octal escapes; anything else becomes '?'.
fn pdf_escape(s: &str) -> String {
  s.chars()
    .flat_map(|c| match c {
      '\u{2022}' => "*".chars().collect::<Vec<_>>(),
      '\u{00b7}' | '\u{2013}' | '\u{2014}' => "-".chars().collect(),
      '\u{2018}' | '\u{2019}' => "'".chars().collect(),
      '\u{201c}' | '\u{201d}' => "\"".chars().collect(),
      '\u{2026}' => "...".chars().collect(),
      '\u{00a0}' => " ".chars().collect(),
      c => vec![c],
    })
    .map(|c| match c {
      '\\' => "\\\\".to_string(),
      '(' => "\\(".to_string(),
      ')' => "\\)".to_string(),
      c if (0xa0..=0xff).contains(&(c as u32)) => format!("\\{:03o}", c as u32),
      c if c.is_control() || c as u32 > 127 => "?".to_string(),
      c => c.to_string(),
    })
    .collect()
}

/// Render a QR code (as a dark-module matrix) for embedding in the PDF.
fn qr_modules(url: &str) -> Option<Vec<Vec<bool>>> {
  let code = qrcode::QrCode::new(url.as_bytes()).ok()?;
  let w = code.width();
  let mut rows = Vec::with_capacity(w);
  for y in 0..w {
    let mut row = Vec::with_capacity(w);
    for x in 0..w {
      row.push(code[(x, y)] == qrcode::Color::Dark);
    }
    rows.push(row);
  }
  Some(rows)
}

const PDF_LINES_PER_PAGE: usize = 52;
const PDF_TOP_Y: f64 = 762.0;
const PDF_LEADING: f64 = 14.0;
const PDF_BOTTOM_MARGIN: f64 = 36.0;
const PDF_QR_SIZE: f64 = 130.0;
const PDF_QR_QUIET: usize = 4;
const PDF_QR_CAPTION: &str = "Scan to leave us a review";
/// Gap between the last text baseline and the caption baseline.
const PDF_QR_TEXT_GAP: f64 = 24.0;
/// Gap between the caption baseline and the top of the QR.
const PDF_QR_CAPTION_GAP: f64 = 8.0;

/// Courier is monospaced at 600/1000 em, so a 10pt glyph is 6pt wide.
fn pdf_center_x(text: &str) -> f64 {
  (612.0 - text.chars().count() as f64 * 6.0) / 2.0
}

fn qr_rects(modules: &[Vec<bool>], x0: f64, y_top: f64, out: &mut String) {
  let n = modules.len();
  let total = n + PDF_QR_QUIET * 2;
  let module = PDF_QR_SIZE / total as f64;
  out.push_str("0 0 0 rg\n");
  for (row, r) in modules.iter().enumerate() {
    for (col, dark) in r.iter().enumerate() {
      if !dark {
        continue;
      }
      let x = x0 + (col + PDF_QR_QUIET) as f64 * module;
      let y = y_top - (row + PDF_QR_QUIET + 1) as f64 * module;
      out.push_str(&format!("{x:.2} {y:.2} {module:.2} {module:.2} re f\n"));
    }
  }
}

fn draw_qr(modules: &[Vec<bool>], caption_y: f64, out: &mut String) {
  out.push_str(&format!(
    "BT\n/F1 10 Tf\n{:.2} {:.2} Td\n({}) Tj\nET\n",
    pdf_center_x(PDF_QR_CAPTION),
    caption_y,
    pdf_escape(PDF_QR_CAPTION)
  ));
  let x0 = (612.0 - PDF_QR_SIZE) / 2.0;
  qr_rects(modules, x0, caption_y - PDF_QR_CAPTION_GAP, out);
}

/// Does the QR block (caption + code) fit below `text_bottom` on this page?
fn qr_fits_below(text_bottom: f64) -> bool {
  text_bottom - PDF_QR_TEXT_GAP - PDF_QR_CAPTION_GAP - PDF_QR_SIZE >= PDF_BOTTOM_MARGIN
}

fn build_simple_pdf(text: &str, qr_url: Option<&str>) -> Vec<u8> {
  let lines: Vec<&str> = text.lines().collect();
  let mut page_lines: Vec<&[&str]> = lines.chunks(PDF_LINES_PER_PAGE).collect();
  if page_lines.is_empty() {
    page_lines.push(&[]);
  }
  let modules = qr_url
    .filter(|u| !u.trim().is_empty())
    .and_then(|u| qr_modules(u.trim()));
  // QR rides the last text page when it fits without touching the margin;
  // a packed page pushes it onto its own page at the top.
  let last_text_bottom =
    PDF_TOP_Y - PDF_LEADING * page_lines.last().map(|p| p.len()).unwrap_or(0) as f64;
  let qr_new_page = modules.is_some() && !qr_fits_below(last_text_bottom);
  let page_count = page_lines.len() + usize::from(qr_new_page);

  let mut streams: Vec<String> = Vec::with_capacity(page_count);
  for chunk in &page_lines {
    let mut content = String::from("BT\n/F1 10 Tf\n36 762 Td\n14 TL\n");
    for (i, line) in chunk.iter().enumerate() {
      let escaped = pdf_escape(line);
      if i == 0 {
        content.push_str(&format!("({escaped}) Tj\n"));
      } else {
        content.push_str(&format!("T* ({escaped}) Tj\n"));
      }
    }
    content.push_str("ET\n");
    streams.push(content);
  }
  if let Some(ref m) = modules {
    if qr_new_page {
      let mut content = String::new();
      draw_qr(m, PDF_TOP_Y, &mut content);
      streams.push(content);
    } else if let Some(last) = streams.last_mut() {
      draw_qr(m, last_text_bottom - PDF_QR_TEXT_GAP, last);
    }
  }

  // Object layout: 1 catalog, 2 pages tree, page objects, content streams, font.
  let page_id = |i: usize| 3 + i;
  let content_id = |i: usize| 3 + page_count + i;
  let font_id = 3 + 2 * page_count;

  let mut pdf = Vec::new();
  let mut offsets: Vec<usize> = Vec::new();
  fn push_obj(pdf: &mut Vec<u8>, offsets: &mut Vec<usize>, body: &[u8]) {
    offsets.push(pdf.len());
    pdf.extend_from_slice(body);
  }
  pdf.extend_from_slice(b"%PDF-1.4\n");
  push_obj(
    &mut pdf,
    &mut offsets,
    b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
  );
  let kids: Vec<String> = (0..page_count)
    .map(|i| format!("{} 0 R", page_id(i)))
    .collect();
  push_obj(
    &mut pdf,
    &mut offsets,
    format!(
      "2 0 obj\n<< /Type /Pages /Kids [{}] /Count {} >>\nendobj\n",
      kids.join(" "),
      page_count
    )
    .as_bytes(),
  );
  for i in 0..page_count {
    push_obj(
      &mut pdf,
      &mut offsets,
      format!(
        "{} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R /Resources << /Font << /F1 {} 0 R >> >> >>\nendobj\n",
        page_id(i),
        content_id(i),
        font_id
      )
      .as_bytes(),
    );
  }
  for (i, stream) in streams.iter().enumerate() {
    push_obj(
      &mut pdf,
      &mut offsets,
      format!(
        "{} 0 obj\n<< /Length {} >>\nstream\n{}endstream\nendobj\n",
        content_id(i),
        stream.len(),
        stream
      )
      .as_bytes(),
    );
  }
  push_obj(
    &mut pdf,
    &mut offsets,
    format!(
      "{} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>\nendobj\n",
      font_id
    )
    .as_bytes(),
  );
  let xref_at = pdf.len();
  pdf.extend_from_slice(format!("xref\n0 {}\n", offsets.len() + 1).as_bytes());
  pdf.extend_from_slice(b"0000000000 65535 f \n");
  for off in &offsets {
    pdf.extend_from_slice(format!("{:010} 00000 n \n", off).as_bytes());
  }
  pdf.extend_from_slice(
    format!(
      "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
      offsets.len() + 1,
      xref_at
    )
    .as_bytes(),
  );
  pdf
}

/// `lp` stdout looks like "request id is F11-7 (1 file(s))".
fn parse_job_id(lp_stdout: &str) -> Option<String> {
  let idx = lp_stdout.find("request id is ")?;
  let rest = &lp_stdout[idx + "request id is ".len()..];
  let id: String = rest
    .chars()
    .take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
    .collect();
  if id.is_empty() {
    None
  } else {
    Some(id)
  }
}

/// The indented line(s) under `lpstat -p <queue>` carry the live state
/// message, e.g. "Waiting for printer to become available."
fn printer_state_lines(lpstat_p_output: &str) -> String {
  lpstat_p_output
    .lines()
    .filter(|l| l.starts_with(' ') || l.starts_with('\t'))
    .map(|l| l.trim())
    .filter(|l| !l.is_empty())
    .collect::<Vec<_>>()
    .join("; ")
}

/// State messages that mean the printer isn't actually printing right now.
fn is_offline_message(msg: &str) -> bool {
  let m = msg.to_lowercase();
  [
    "waiting for printer to become available",
    "not connected",
    "offline",
    "unable to",
  ]
  .iter()
  .any(|needle| m.contains(needle))
}

/// `lpstat -W not-completed -o <queue>` lists each pending job id first.
fn job_pending_in_output(output: &str, job_id: &str) -> bool {
  output
    .lines()
    .any(|l| l.split_whitespace().next() == Some(job_id))
}

fn cups_job_pending(queue: &str, job_id: &str) -> Option<bool> {
  let out = Command::new("lpstat")
    .args(["-W", "not-completed", "-o", queue])
    .output()
    .ok()?;
  Some(job_pending_in_output(
    &String::from_utf8_lossy(&out.stdout),
    job_id,
  ))
}

fn cups_state_message(queue: &str) -> String {
  Command::new("lpstat")
    .args(["-p", queue])
    .output()
    .map(|o| printer_state_lines(&String::from_utf8_lossy(&o.stdout)))
    .unwrap_or_default()
}

// Async command: printing blocks for seconds while we poll the queue, so it
// must run off the UI thread.
#[tauri::command]
async fn print_bytes(data: Vec<u8>, printer_path: String, raw: Option<bool>) -> Result<serde_json::Value, String> {
  let path = Path::new(&printer_path);
  if !printer_path.is_empty() && path.exists() {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .open(path)
      .map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    return Ok(serde_json::json!({
      "printed": true,
      "detail": format!("Printed to {printer_path}")
    }));
  }

  let queue = if printer_path.is_empty() {
    match cups_default_printer() {
      Some(q) => q,
      None => {
        if !cups_has_any_printer() {
          return Ok(serde_json::json!({
            "printed": false,
            "code": "no_printer",
            "detail": "no printer configured"
          }));
        }
        return Ok(serde_json::json!({
          "printed": false,
          "code": "no_printer",
          "detail": "no printer configured"
        }));
      }
    }
  } else {
    printer_path.clone()
  };

  if cups_printer_offline(&queue) == Some(true) {
    return Ok(serde_json::json!({
      "printed": false,
      "code": "printer_offline",
      "detail": format!("printer {queue} is offline")
    }));
  }

  let use_raw = raw.unwrap_or(false);
  let mut cmd = Command::new("lp");
  if use_raw {
    cmd.args(["-o", "raw"]);
  }
  cmd.args(["-d", &queue]);
  cmd.arg("-").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
  match cmd.spawn() {
    Ok(mut child) => {
      if let Some(stdin) = child.stdin.take() {
        let mut stdin = stdin;
        stdin.write_all(&data).map_err(|e| e.to_string())?;
      }
      let output = child.wait_with_output().map_err(|e| e.to_string())?;
      if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
          format!("printer error: lp exited {}", output.status)
        } else {
          format!("printer error: {stderr}")
        };
        return Ok(serde_json::json!({
          "printed": false,
          "detail": detail
        }));
      }
      let job_id = parse_job_id(&String::from_utf8_lossy(&output.stdout));
      // A queued job isn't a printed receipt: CUPS happily holds jobs for an
      // unplugged printer forever. Watch the job until it leaves the queue,
      // the printer reports it can't print, or we give up waiting.
      let start = std::time::Instant::now();
      let mut offline_since: Option<std::time::Instant> = None;
      loop {
        if let Some(ref id) = job_id {
          if cups_job_pending(&queue, id) == Some(false) {
            return Ok(serde_json::json!({
              "printed": true,
              "detail": format!("Printed on {queue}")
            }));
          }
        }
        let state = cups_state_message(&queue);
        if is_offline_message(&state) {
          if offline_since.is_none() {
            offline_since = Some(std::time::Instant::now());
          } else if offline_since.unwrap().elapsed() >= std::time::Duration::from_secs(3) {
            if let Some(ref id) = job_id {
              let _ = Command::new("cancel").arg(id).output();
            }
            return Ok(serde_json::json!({
              "printed": false,
              "code": "printer_offline",
              "detail": format!(
                "Printer {queue} didn't print — {state}. Check that it is turned on and the USB cable is plugged in, then try again. (The job was canceled so it won't print later.)"
              )
            }));
          }
        } else {
          offline_since = None;
        }
        if start.elapsed() >= std::time::Duration::from_secs(25) {
          return Ok(serde_json::json!({
            "printed": true,
            "detail": format!("Sent to {queue} — still printing.")
          }));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
      }
    }
    Err(err) => Ok(serde_json::json!({
      "printed": false,
      "code": "no_printer",
      "detail": format!("no printer configured ({err})")
    })),
  }
}

#[tauri::command]
fn list_printers() -> Result<serde_json::Value, String> {
  let printers = list_cups_printers();
  let default = cups_default_printer();
  Ok(serde_json::json!({
    "printers": printers,
    "default": default,
  }))
}

#[tauri::command]
fn save_receipt_pdf(
  text: String,
  path: Option<String>,
  qr_url: Option<String>,
) -> Result<serde_json::Value, String> {
  let ts = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  let dest = path
    .filter(|p| !p.trim().is_empty())
    .unwrap_or_else(|| format!("/tmp/floor-receipt-{ts}.pdf"));
  let dest_path = PathBuf::from(&dest);
  if dest.ends_with(".txt") {
    fs::write(&dest_path, text.as_bytes()).map_err(|e| e.to_string())?;
  } else {
    let pdf = build_simple_pdf(&text, qr_url.as_deref());
    fs::write(&dest_path, pdf).map_err(|e| e.to_string())?;
  }
  Ok(serde_json::json!({
    "ok": true,
    "path": dest_path.display().to_string(),
  }))
}

/// PDF bytes for a letter-size receipt, with the review QR drawn in.
/// Printed through `print_bytes` (non-raw) so CUPS rasterizes it.
#[tauri::command]
fn receipt_pdf(text: String, qr_url: Option<String>) -> Result<Vec<u8>, String> {
  Ok(build_simple_pdf(&text, qr_url.as_deref()))
}

/// Guess the receipt layout for a CUPS queue from its PPD page sizes:
/// narrow roll printers (≤ ~90mm widths, no Letter/A4) get ESC/POS roll
/// output; anything that takes letter/A4 pages gets the full-page layout.
#[tauri::command]
fn printer_paper_hint(name: String) -> Result<serde_json::Value, String> {
  if name.trim().is_empty() {
    return Ok(serde_json::json!({ "hint": "letter" }));
  }
  let out = Command::new("lpoptions")
    .args(["-p", &name, "-l"])
    .output()
    .map_err(|e| e.to_string())?;
  if !out.status.success() {
    return Ok(serde_json::json!({ "hint": "letter", "detail": "no ppd" }));
  }
  let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
  let page_line = text
    .lines()
    .find(|l| l.starts_with("pagesize"))
    .unwrap_or("");
  let has_sheet = ["letter", "legal", "a4", "a3", "tabloid", "ansic", "archa", "superb"]
    .iter()
    .any(|t| page_line.contains(t));
  if has_sheet {
    return Ok(serde_json::json!({ "hint": "letter" }));
  }
  if page_line.contains("58") {
    return Ok(serde_json::json!({ "hint": "roll58" }));
  }
  Ok(serde_json::json!({ "hint": "roll80" }))
}

#[tauri::command]
fn kiosk_power(action: String) -> Result<serde_json::Value, String> {
  if action != "poweroff" && action != "reboot" {
    return Err("bad action".into());
  }
  let status = Command::new("sudo")
    .args(["-n", "systemctl", &action])
    .status()
    .map_err(|e| e.to_string())?;
  Ok(serde_json::json!({ "ok": status.success(), "detail": action }))
}

fn pin_hash(pin: &str) -> String {
  let mut h = Sha256::new();
  h.update(pin.as_bytes());
  hex::encode(h.finalize())
}

#[tauri::command]
fn set_admin_pin(pin: String) -> Result<(), String> {
  with_db(|conn| {
    conn
      .execute(
        "insert into kv(key, value) values('admin_pin', ?1)
         on conflict(key) do update set value = excluded.value",
        params![pin_hash(&pin)],
      )
      .map_err(|e| e.to_string())?;
    Ok(())
  })
}

#[tauri::command]
fn verify_admin_pin(pin: String) -> Result<bool, String> {
  with_db(|conn| {
    let stored: Result<String, _> = conn.query_row("select value from kv where key = 'admin_pin'", [], |r| r.get(0));
    match stored {
      Ok(hash) => Ok(hash == pin_hash(&pin)),
      Err(_) => Ok(false),
    }
  })
}

#[tauri::command]
fn has_admin_pin() -> Result<bool, String> {
  with_db(|conn| {
    let n: i64 = conn
      .query_row("select count(*) from kv where key = 'admin_pin'", [], |r| r.get(0))
      .unwrap_or(0);
    Ok(n > 0)
  })
}

pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      open_db(app.handle()).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      cache_replace_units,
      search_units,
      outbox_insert,
      outbox_pending,
      outbox_update,
      incident_insert,
      incidents_list,
      settings_get,
      settings_set,
      print_bytes,
      list_printers,
      save_receipt_pdf,
      receipt_pdf,
      printer_paper_hint,
      kiosk_power,
      set_admin_pin,
      verify_admin_pin,
      has_admin_pin
    ])
    .run(tauri::generate_context!())
    .expect("error while running Floor POS");
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_lp_job_id() {
    assert_eq!(
      parse_job_id("request id is F11-7 (1 file(s))"),
      Some("F11-7".to_string())
    );
    assert_eq!(parse_job_id("request id is F11-12"), Some("F11-12".to_string()));
    assert_eq!(parse_job_id("no id here"), None);
    assert_eq!(parse_job_id("request id is "), None);
  }

  #[test]
  fn detects_offline_state_messages() {
    assert!(is_offline_message("Waiting for printer to become available."));
    assert!(is_offline_message("The printer is not connected."));
    assert!(is_offline_message("Printer is offline"));
    assert!(is_offline_message("Unable to send data to printer."));
    assert!(!is_offline_message("Rendering completed"));
    assert!(!is_offline_message(""));
  }

  #[test]
  fn finds_pending_job_in_lpstat_output() {
    let out = "F11-7                prime            2048   Sun 01 Jan 10:00\nF11-9                prime            1024   Sun 01 Jan 10:01\n";
    assert!(job_pending_in_output(out, "F11-7"));
    assert!(job_pending_in_output(out, "F11-9"));
    assert!(!job_pending_in_output(out, "F11-8"));
  }

  #[test]
  fn extracts_indented_state_lines() {
    let out = "printer F11 now printing F11-7.  enabled since Sun 01 Jan 10:00\n\tWaiting for printer to become available.\n";
    assert_eq!(
      printer_state_lines(out),
      "Waiting for printer to become available."
    );
    assert_eq!(printer_state_lines("printer F11 is idle.  enabled since x"), "");
  }

  #[test]
  fn escape_transliterates_receipt_glyphs() {
    assert_eq!(pdf_escape("•••• 4242"), "**** 4242");
    assert_eq!(pdf_escape("CARD · Visa"), "CARD - Visa");
    assert_eq!(pdf_escape("a–b—c"), "a-b-c");
    assert_eq!(pdf_escape("‘hi’ “yo” …"), "'hi' \"yo\" ...");
    assert_eq!(pdf_escape("a\u{00a0}b"), "a b");
    // Latin-1 survives as an octal escape; anything beyond becomes '?'.
    assert_eq!(pdf_escape("café"), "caf\\351");
    assert_eq!(pdf_escape("¥100 中"), "\\245100 ?");
    assert_eq!(pdf_escape("(x) \\ y"), "\\(x\\) \\\\ y");
  }

  fn pdf_text(pdf: &[u8]) -> String {
    String::from_utf8_lossy(pdf).into_owned()
  }

  #[test]
  fn paginates_at_52_lines_per_page() {
    let short: String = (0..10).map(|i| format!("line {i}\n")).collect();
    let pdf = pdf_text(&build_simple_pdf(&short, None));
    assert!(pdf.contains("/Count 1"), "{pdf}");
    assert!(pdf.contains("/Kids [3 0 R]"), "{pdf}");

    let long: String = (0..120).map(|i| format!("line {i}\n")).collect();
    let pdf = pdf_text(&build_simple_pdf(&long, None));
    assert!(pdf.contains("/Count 3"), "{pdf}");
    assert!(pdf.contains("/Kids [3 0 R 4 0 R 5 0 R]"), "{pdf}");
    // Font object follows the three content streams (ids 6..8) → id 9.
    assert!(pdf.contains("/Encoding /WinAnsiEncoding"), "{pdf}");
  }

  #[test]
  fn qr_moves_to_own_page_when_text_is_full() {
    // 40 lines leaves room: QR shares the last page.
    let short: String = (0..40).map(|i| format!("line {i}\n")).collect();
    let pdf = pdf_text(&build_simple_pdf(&short, Some("https://example.com/review")));
    assert!(pdf.contains("/Count 1"), "{pdf}");
    assert!(pdf.contains("re f"), "{pdf}");
    assert!(pdf.contains("Scan to leave us a review"), "{pdf}");

    // 52 lines fills the page past the QR's room → QR gets a second page.
    let full: String = (0..52).map(|i| format!("line {i}\n")).collect();
    let pdf = pdf_text(&build_simple_pdf(&full, Some("https://example.com/review")));
    assert!(pdf.contains("/Count 2"), "{pdf}");
    assert!(pdf.contains("/Kids [3 0 R 4 0 R]"), "{pdf}");
  }

  #[test]
  fn writes_sample_receipt_pdf() {
    let mut text = String::from("FLOOR\n3121 Penryn Rd, Penryn, CA\n\n");
    for i in 0..34 {
      text.push_str(&format!("Item {:02}                      $19.99\n", i + 1));
    }
    text.push_str("Tender       CARD · Visa •••• 4242\nTotal                       $19.99\n");
    let pdf = build_simple_pdf(&text, Some("https://example.com/review"));
    fs::write("/tmp/floor-sample-receipt.pdf", &pdf).expect("write sample pdf");
    let s = pdf_text(&pdf);
    assert!(s.contains("**** 4242"), "{s}");
    assert!(s.contains("/Count 1"), "{s}");
  }
}
