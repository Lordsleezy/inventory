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

fn with_db<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
  let guard = DB.lock().map_err(|e| e.to_string())?;
  let conn = guard.as_ref().ok_or_else(|| "db not open".to_string())?;
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

#[tauri::command]
fn print_bytes(data: Vec<u8>, printer_path: String, raw: Option<bool>) -> Result<serde_json::Value, String> {
  let path = Path::new(&printer_path);
  if !printer_path.is_empty() && path.exists() {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .open(path)
      .map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    return Ok(serde_json::json!({ "printed": true, "detail": printer_path }));
  }
  let use_raw = raw.unwrap_or(false);
  let mut cmd = Command::new("lp");
  if use_raw {
    cmd.args(["-o", "raw"]);
  }
  if !printer_path.is_empty() {
    cmd.args(["-d", &printer_path]);
  }
  let status = cmd.arg("-").stdin(std::process::Stdio::piped()).spawn();
  match status {
    Ok(mut child) => {
      if let Some(stdin) = child.stdin.as_mut() {
        stdin.write_all(&data).map_err(|e| e.to_string())?;
      }
      let ok = child.wait().map_err(|e| e.to_string())?.success();
      Ok(serde_json::json!({ "printed": ok, "detail": "cups lp" }))
    }
    Err(err) => {
      let fallback = PathBuf::from("/tmp/floor-last-receipt.bin");
      fs::write(&fallback, &data).map_err(|e| e.to_string())?;
      Ok(serde_json::json!({
        "printed": false,
        "detail": format!("no printer ({err}); wrote {}", fallback.display())
      }))
    }
  }
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
      kiosk_power,
      set_admin_pin,
      verify_admin_pin,
      has_admin_pin
    ])
    .run(tauri::generate_context!())
    .expect("error while running Floor POS");
}
