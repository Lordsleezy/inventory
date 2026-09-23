import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class FloorDesktop extends Extension {
    enable() {
        if (GLib.get_user_name() !== 'store') return;
        this._buttons = [];
        this._mapId = global.window_manager.connect('map', (_wm, actor) => {
            const window = actor.meta_window;
            const parent = window.get_transient_for() ?? window;
            const appId = Shell.WindowTracker.get_default().get_window_app(parent)?.get_id() ?? '';
            const wmClass = parent.get_wm_class() ?? '';
            const floor = appId === 'floor-pos.desktop' || /floor|com\.floor\.register/i.test(wmClass);
            const firefox = /firefox/i.test(appId) || /firefox/i.test(wmClass);
            if (!floor && !firefox) {
                window.delete(global.get_current_time());
                return;
            }
            if (floor && !window.get_transient_for()) {
                // Keep the taskbar accessible above the register.
                window.unmake_fullscreen();
                window.maximize();
            }
        });
        for (const [label, desktop] of [['Floor', 'floor-pos.desktop'], ['Firefox', 'firefox_firefox.desktop']]) {
            const button = new PanelMenu.Button(0, label, true);
            button.add_child(new St.Label({text: label, y_align: 2}));
            button.connect('button-press-event', () => {
                Shell.AppSystem.get_default().lookup_app(desktop)?.activate();
            });
            Main.panel.addToStatusArea(`floor-${label}`, button, this._buttons.length, 'left');
            this._buttons.push(button);
        }
        const logout = new PanelMenu.Button(0, 'Log Out', true);
        logout.add_child(new St.Label({text: 'Log Out', y_align: 2}));
        logout.connect('button-press-event', () => {
            Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
                'org.gnome.SessionManager', 'Logout', new GLib.Variant('(u)', [0]),
                null, Gio.DBusCallFlags.NONE, -1, null, null);
        });
        Main.panel.addToStatusArea('floor-logout', logout, 0, 'right');
        this._buttons.push(logout);
    }
    disable() {
        if (this._mapId) global.window_manager.disconnect(this._mapId);
        this._mapId = null;
        for (const button of this._buttons ?? []) button.destroy();
        this._buttons = [];
    }
}
