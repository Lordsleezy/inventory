import { BuildStamp } from './BuildStamp';
import { DESK_GROUPS, ASSOCIATE_LINKS, type DeskLink } from './deskNav';
import type { DeskPulse } from './deskPulse';
import type { InventoryTab, MainPage } from './navigation';

type Props = {
  page: MainPage;
  inventoryTab?: InventoryTab;
  fullAccess: boolean;
  pulse: DeskPulse;
  name: string;
  role: string;
  onOpen: (link: Pick<DeskLink, 'page' | 'inventoryTab'>) => void;
  onSignOut: () => void;
};

export function DeskSidebar({ page, inventoryTab, fullAccess, pulse, name, role, onOpen, onSignOut }: Props) {
  const groups = fullAccess ? DESK_GROUPS : [{ label: 'Your desk', links: ASSOCIATE_LINKS }];
  return (
    <>
      <div className="aside-brand">
        <div className="brand">OPEN BOX <span>INDUSTRIES</span></div>
        <div className="product">Floor <b>Admin</b></div>
      </div>
      <nav id="admin-nav-list" aria-label="Main">
        <button type="button" className={page === 'home' ? 'active' : ''} onClick={() => onOpen({ page: 'home' })}>Home</button>
        {groups.map((group) => (
          <div className="desk-nav-group" key={group.label}>
            <p>{group.label}</p>
            {group.links.map((link) => (
              <button type="button" key={link.label} className={(link.inventoryTab ? page === link.page && inventoryTab === link.inventoryTab : page === link.page) ? 'active' : ''} onClick={() => onOpen(link)}>
                <span>{link.label}</span>
                {link.page === 'orders' && pulse.toShip != null && pulse.toShip > 0 && <small>{pulse.toShip}</small>}
                {link.page === 'returns' && pulse.openReturns != null && pulse.openReturns > 0 && <small>{pulse.openReturns}</small>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="account">
        <strong>{name}</strong>
        <small>{role}</small>
        <button type="button" onClick={onSignOut}>Sign out</button>
        <BuildStamp />
      </div>
    </>
  );
}
