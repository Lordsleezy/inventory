import type { ReactNode } from 'react';
export type ToolIconName = 'bank'|'cash'|'file'|'upload'|'tag'|'bay'|'move'|'scan'|'plus'|'save'|'info'|'calendar'|'person'|'money'|'flip'|'settings'|'reset';
const paths: Record<ToolIconName, ReactNode> = {
 bank:<><path d="m3 8 9-5 9 5ZM4 21h16M6 10v7m6-7v7m6-7v7M4 18h16"/></>,
 cash:<><rect x="2" y="5" width="20" height="14" rx="2"/><circle cx="12" cy="12" r="3"/></>,
 file:<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h6"/></>,
 upload:<path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4"/>,
 tag:<><path d="M20 3h-7L2 14l8 8L21 11V4Z"/><circle cx="16" cy="7" r="1"/></>,
 bay:<path d="M4 3v18M20 3v18M4 5h16M4 12h16M4 19h16M8 5v3m8-3v3M8 12v3m8-3v3"/>,
 move:<path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>,
 scan:<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 8v8m3-8v8m4-8v8m3-8v8"/>,
 plus:<path d="M12 4v16M4 12h16"/>, save:<path d="M4 3h13l4 4v14H3V3ZM7 3v6h10V3M7 21v-7h10v7"/>,
 info:<><circle cx="12" cy="12" r="10"/><path d="M12 11v6m0-10v.1"/></>,
 calendar:<><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18"/></>,
 person:<><circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3Z"/></>,
 money:<path d="M12 2v20m5-15c0-4-10-4-10 0s10 4 10 9-10 5-10 0"/>,
 flip:<path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>,
 settings:<><path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
 reset:<path d="M3 11a9 9 0 1 0 3-6M3 3v6h6"/>,
};
export function ToolIcon({name,className=''}:{name:ToolIconName;className?:string}) {return <svg className={`tool-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;}
export function ToolHeading({icon,title,description,action}:{icon:ToolIconName;title:string;description?:string;action?:ReactNode}) {return <div className="tool-section-head"><span className="tool-icon-badge"><ToolIcon name={icon}/></span><div><h2>{title}</h2></div>{action}{description&&<p className="tool-head-description">{description}</p>}</div>;}
export function ToolCard({children,className=''}:{children:ReactNode;className?:string}) {return <section className={`panel tool-card ${className}`}>{children}</section>;}
export function ToolEmpty({icon,title,children}:{icon:ToolIconName;title:string;children?:ReactNode}) {return <div className="tool-empty"><span className="tool-icon-badge"><ToolIcon name={icon}/></span><strong>{title}</strong>{children}</div>;}
export function ToolTip({children}:{children:ReactNode}) {return <div className="tool-tip" role="note"><ToolIcon name="info"/><div><strong>Quick tip</strong><p>{children}</p></div></div>;}
export function ToolSourceBadge({source}:{source:string}) {
 const content=source==='safe'?<ToolIcon name="cash"/>:source==='square'?<span className="source-square">&#9634;</span>:source==='ebay'?<span className="source-ebay"><i>e</i><i>b</i><i>a</i><i>y</i></span>:source==='amazon'?<span className="source-amazon">a<span>&#8995;</span></span>:source==='tiktok'?<span className="source-tiktok">&#9834;</span>:source==='depop'?<span className="source-depop">d</span>:<ToolIcon name="bank"/>;
 return <span className={`tool-icon-badge source-badge source-${source}`} aria-hidden="true">{content}</span>;
}
