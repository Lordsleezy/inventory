import sqlite3
import sys

db = sys.argv[1]
con = sqlite3.connect(db)
con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
if len(sys.argv) > 2 and sys.argv[2] == "wipe-stock":
    con.execute("PRAGMA foreign_keys=OFF")
    for name in (
        "stock_stockitemtestresult",
        "stock_stockitemtracking",
        "order_salesorderallocation",
        "stock_stockitem",
    ):
        n = con.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
        con.execute(f"DELETE FROM {name}")
        print(f"wiped {name} ({n})")
    con.commit()
    print("wiped")
else:
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1")]
    print("\n".join(tables))
con.close()
