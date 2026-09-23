# Employee desktop (GNOME 50)

Run `sudo bash apps/pos/packaging/install-store-session.sh` after building Floor.
This installs the register system-wide and creates the standard, passwordless
`store` account. GDM remains active. Select Store to enter the Floor Store session;
select prime to enter the existing Ubuntu desktop with its existing password.
The Ubuntu session entry also routes store to Floor Store, so changing GDM's
session selector does not bypass its desktop restrictions.

The root-owned session mode removes Overview, Run, Settings, notifications and
window menus. The taskbar provides Floor, Firefox and Log Out. Floor opens on
login, with its normal Floor authentication. The extension keeps Floor maximized
so the taskbar remains accessible and closes other application windows. Dconf
locks disable launch shortcuts, virtual-terminal switching and power controls.
Polkit denies employee elevation/system changes. Account-specific executable
ACLs deny the installed terminal, file manager, settings and software launchers.
These ACLs may need reapplying after package upgrades.

This is a restricted GNOME desktop, not a security sandbox for arbitrary browser
code or downloaded executables. Do not describe it as an OS-wide executable
allowlist. GDM, GNOME and Firefox updates require retesting the restrictions.

`sudo bash apps/pos/packaging/verify-store-session.sh` checks account membership,
password states, both accounts' Floor access, dconf values and locks, executable
ACLs, GDM availability and employee polkit denials. A graphical login additionally
checks the taskbar, autostart and window behavior.

The installer changes no printer/CUPS settings, phone code, or prime preferences.
Original Ubuntu GDM launcher: `/var/backups/floor-store/ubuntu.desktop`.

Clerk card flow: ring items → Card → charge the large quoted amount in the phone's
Square app → Card paid — complete sale → Print / Email / No receipt. Split adds a
cash entry first. Tax and fees come from the server quote and finalize_ticket;
manual payment references are explicitly `manual:<ticket UUID>`. An interrupted
confirmation remains on that employee's register for an idempotent retry.

Card refunds: Receipts → Void ticket (manager approval when required) → refund
the displayed amount in Square. Split refunds show the recorded card amount
(which already includes its fee) and the cash to return. Floor does not call
Square to refund. Existing Square backend functions/tables and phone app remain.
