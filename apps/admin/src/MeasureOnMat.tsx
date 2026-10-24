import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { rectifyMatPhoto } from './matMeasure';

type Measurements = { length: string; width: string; height: string };
export function MeasureOnMat({ onApply, onClose }: { onApply: (value: Measurements, target: 'product' | 'package') => void; onClose: () => void }) {
  const [stage, setStage] = useState<'top' | 'side'>('top');
  const [image, setImage] = useState('');
  const [points, setPoints] = useState<{x:number;y:number}[]>([]);
  const [values, setValues] = useState<Measurements>({length:'',width:'',height:''});
  const [target, setTarget] = useState<'product'|'package'>('product');
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function load(file?: File) {
    if (!file) return;
    setBusy(true);setError('');setPoints([]);setImage('');
    try { setImage(await rectifyMatPhoto(file)); } catch(e) { setError(e instanceof Error ? e.message : 'Photo could not be measured.'); }
    finally { setBusy(false); }
  }
  return createPortal(<div style={{position:'fixed',inset:0,zIndex:200,background:'#17232dcc',display:'grid',placeItems:'center',padding:8}}><section role="dialog" aria-modal="true" aria-label="Measure on mat" style={{maxHeight:'95dvh',overflow:'auto',width:'min(95vw,600px)',background:'white',color:'#17232d',borderRadius:16,padding:20,boxSizing:'border-box'}}>
    <h2 style={{color:'inherit'}}>Measure on mat</h2>
    <p><a href="/floor-aruco-mat.pdf" target="_blank" rel="noreferrer">Print letter-size ArUco mat</a> at 100%. Check the printed scale with a ruler.</p>
    <label>Measuring<select value={target} onChange={e=>{setTarget(e.target.value as 'product'|'package');setValues({length:'',width:'',height:''});setStage('top');setImage('');setPoints([]);}}><option value="product">Product</option><option value="package">Actual shipping package</option></select></label>
    <p>{stage==='top' ? 'Top photo: camera directly overhead. Keep all markers visible. Tap two opposite corners of the item to mark its length and width.' : 'Side photo: stand the mat upright beside the item, in the same plane as its side. Tap the bottom and top of the item.'}</p>
    <p>Keep the item square with the mat. Perspective and a raised surface can affect accuracy. Review with a ruler before shipping.</p>
    <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={e=>{void load(e.currentTarget.files?.[0]);e.currentTarget.value='';}} />
    <button type="button" disabled={busy} onClick={()=>input.current?.click()}>{busy?'Reading ArUco markers…':`Take ${stage} photo`}</button>
    {error&&<p role="alert">{error}</p>}
    {image&&<div style={{position:'relative',maxWidth:340,margin:'auto'}}>
      <img src={image} alt="Calibrated mat; tap item edges" style={{width:'100%',display:'block',touchAction:'manipulation'}} onClick={e=>{
        const rect=e.currentTarget.getBoundingClientRect();const point={x:(e.clientX-rect.left)/rect.width*8.5,y:(e.clientY-rect.top)/rect.height*11};
        const next=points.length===2?[point]:[...points,point];setPoints(next);
        if(next.length===2){const dx=Math.abs(next[1].x-next[0].x),dy=Math.abs(next[1].y-next[0].y);
          if(stage==='top')setValues(v=>({...v,length:dx.toFixed(2),width:dy.toFixed(2)}));else setValues(v=>({...v,height:dy.toFixed(2)}));}
      }}/>
      {points.map((p,i)=><span key={i} style={{position:'absolute',pointerEvents:'none',left:`${p.x/8.5*100}%`,top:`${p.y/11*100}%`,transform:'translate(-50%,-50%)',color:'red',fontSize:28}}>+</span>)}
    </div>}
    {stage==='top'&&values.length&&values.width&&<button type="button" onClick={()=>{setStage('side');setImage('');setPoints([]);}}>Next: side photo for height</button>}
    <div>{(['length','width','height'] as const).map(key=><label key={key}>{key} (in)<input type="number" min="0" step="0.01" inputMode="decimal" value={values[key]} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))}/></label>)}</div>
    <p>Weight is never measured from a photo. Enter scale weight separately.</p>
    <button type="button" disabled={!Object.values(values).every(v=>Number(v)>0)} onClick={()=>onApply(values,target)}>Use reviewed measurements</button>
    <button type="button" className="secondary" onClick={onClose}>Cancel</button>
  </section></div>, document.body);
}
