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

fn pdf_escape(s: &str) -> String {
  s.chars()
    .map(|c| match c {
      '\\' => "\\\\".to_string(),
      '(' => "\\(".to_string(),
      ')' => "\\)".to_string(),
      c if c.is_control() || c as u32 > 127 => format!("\\{:03o}", (c as u32).min(255)),
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

fn build_simple_pdf(text: &str, qr_url: Option<&str>) -> Vec<u8> {
  let lines: Vec<&str> = text.lines().collect();
  let mut content = String::from("BT\n/F1 10 Tf\n36 762 Td\n14 TL\n");
  for (i, line) in lines.iter().enumerate() {
    let escaped = pdf_escape(line);
    if i == 0 {
      content.push_str(&format!("({escaped}) Tj\n"));
    } else {
      content.push_str(&format!("T* ({escaped}) Tj\n"));
    }
  }
  content.push_str("ET\n");

  // Draw the review QR as filled squares centered below the text block.
  if let Some(url) = qr_url.filter(|u| !u.trim().is_empty()) {
    if let Some(modules) = qr_modules(url.trim()) {
      let n = modules.len();
      let quiet = 2usize;
      let total = n + quiet * 2;
      // ~110pt QR on a letter page.
      let size = 110.0f64;
      let module = size / total as f64;
      let x0 = (612.0 - size) / 2.0;
      let text_bottom = 762.0 - 14.0 * lines.len() as f64;
      let y_top = (text_bottom - 24.0).max(150.0).min(700.0);
      content.push_str("0 0 0 rg\n");
      for (row, r) in modules.iter().enumerate() {
        for (col, dark) in r.iter().enumerate() {
          if !dark {
            continue;
          }
          let x = x0 + (col + quiet) as f64 * module;
          let y = y_top - (row + quiet + 1) as f64 * module;
          content.push_str(&format!("{x:.2} {y:.2} {module:.2} {module:.2} re f\n"));
        }
      }
    }
  }
  let stream = content.into_bytes();
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
  push_obj(
    &mut pdf,
    &mut offsets,
    b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
  );
  push_obj(
    &mut pdf,
    &mut offsets,
    b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
  );
  let stream_obj = format!(
    "4 0 obj\n<< /Length {} >>\nstream\n{}endstream\nendobj\n",
    stream.len(),
    String::from_utf8_lossy(&stream)
  );
  push_obj(&mut pdf, &mut offsets, stream_obj.as_bytes());
  push_obj(
    &mut pdf,
    &mut offsets,
    b"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n",
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

#[tauri::command]
fn print_bytes(data: Vec<u8>, printer_path: String, raw: Option<bool>) -> Result<serde_json::Value, String> {
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
      Ok(serde_json::json!({
        "printed": true,
        "detail": format!("Printed to {queue}")
      }))
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
