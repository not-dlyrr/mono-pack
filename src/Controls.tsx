import {useEffect,useLayoutEffect,useRef,useState,useId,type ReactNode,type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {Check,ChevronDown,Minus,Square,Copy,X} from 'lucide-react';
import {isTauri} from '@tauri-apps/api/core';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {GlassChrome} from './Glass';

export function Checkbox({checked,onChange,children}:{checked:boolean;onChange:(checked:boolean)=>void;children:ReactNode}) {
  return <button type="button" role="checkbox" aria-checked={checked} className="check" onClick={()=>onChange(!checked)}><span className="checkbox-box" aria-hidden="true">{checked&&<Check size={15} strokeWidth={2.5}/>}</span><span>{children}</span></button>;
}

export function Dropdown({label,value,options,onChange}:{label:string;value:string;options:string[];onChange:(value:string)=>void}) {
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false),[active,setActive]=useState(0),[position,setPosition]=useState({left:0,top:0,width:0,maxHeight:300});
  const search=useRef({text:'',at:0});
  const close=()=>setOpen(false);
  const show=()=>{setActive(Math.max(0,options.indexOf(value)));setOpen(true);};
  useLayoutEffect(()=>{
    if(!open)return;
    const update=()=>{const rect=trigger.current!.getBoundingClientRect(),box=getComputedStyle(menu.current!.parentElement!),chrome=parseFloat(box.paddingTop)+parseFloat(box.paddingBottom)+parseFloat(box.borderTopWidth)+parseFloat(box.borderBottomWidth),height=Math.min(Math.ceil(menu.current!.scrollHeight+chrome),300),below=innerHeight-rect.bottom-12,above=rect.top-12;const up=below<height&&above>below;const maxHeight=Math.max(0,Math.min(height,up?above:below));setPosition({left:Math.min(rect.left,Math.max(8,innerWidth-rect.width-8)),width:rect.width,top:up?rect.top-maxHeight-6:rect.bottom+6,maxHeight});};
    update();const resize=new ResizeObserver(update);resize.observe(menu.current!);window.addEventListener('resize',update);window.addEventListener('scroll',update,true);
    const ownsScrollbar=(target:EventTarget|null)=>target instanceof Element&&(target.closest('[role="scrollbar"]')||target.closest('.mono-scroll-track')?.querySelector('[role="scrollbar"]'))?.getAttribute('aria-controls')===`${id}-list`;
    const outside=(e:PointerEvent)=>{if(!trigger.current?.contains(e.target as Node)&&!menu.current?.contains(e.target as Node)&&!ownsScrollbar(e.target))close();};
    const escape=(e:globalThis.KeyboardEvent)=>{if(e.key==='Escape'&&ownsScrollbar(e.target)){e.preventDefault();close();trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{resize.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open,options.length]);
  useEffect(()=>{if(open)document.getElementById(`${id}-${active}`)?.scrollIntoView({block:'nearest'});},[active,open,id]);
  function key(e:KeyboardEvent<HTMLButtonElement>){
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
      e.preventDefault();if(!open){show();return;}
      setActive(i=>e.key==='Home'?0:e.key==='End'?options.length-1:(i+(e.key==='ArrowDown'?1:-1)+options.length)%options.length);return;
    }
    if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();close();return;}
    if(e.key==='Tab'){close();return;}
    if(e.key==='Enter'||e.key===' '){e.preventDefault();if(open){onChange(options[active]);close();}else show();return;}
    if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();const now=Date.now();search.current.text=now-search.current.at>700?e.key:search.current.text+e.key;search.current.at=now;let match=options.findIndex(o=>o.toLowerCase().startsWith(search.current.text.toLowerCase()));if(match<0){search.current.text=e.key;match=options.findIndex(o=>o.toLowerCase().startsWith(e.key.toLowerCase()));}if(match>=0){if(open)setActive(match);else onChange(options[match]);}}
  }
  return <div className="dropdown-field"><span id={`${id}-label`}>{label}</span><button ref={trigger} type="button" role="combobox" aria-labelledby={`${id}-label`} aria-expanded={open} aria-controls={open?`${id}-list`:undefined} aria-haspopup="listbox" aria-activedescendant={open?`${id}-${active}`:undefined} className="dropdown-trigger" onClick={()=>open?close():show()} onKeyDown={key} onBlur={e=>{if(!(e.relatedTarget instanceof Element)||e.relatedTarget.closest('[role="scrollbar"]')?.getAttribute('aria-controls')!==`${id}-list`)close();}}><span>{value.toUpperCase()}</span><ChevronDown size={17}/></button>{open&&createPortal(<GlassChrome className="dropdown-content" style={{position:'fixed',...position}} role="listbox" id={`${id}-list`} aria-labelledby={`${id}-label`} onMouseDown={e=>e.preventDefault()}><div ref={menu}>{options.map((option,i)=><div key={option} role="option" id={`${id}-${i}`} aria-selected={option===value} className={`dropdown-option ${i===active?'highlighted':''}`} onPointerMove={()=>setActive(i)} onClick={()=>{onChange(option);close();trigger.current?.focus();}}><span>{option.toUpperCase()}</span>{option===value&&<Check size={16}/>}</div>)}</div></GlassChrome>,document.body)}</div>;
}

export function Titlebar({onError}:{onError:(error:string)=>void}) {
  const [maximized,setMaximized]=useState(false),native=isTauri();
  useEffect(()=>{if(!native)return;const win=getCurrentWindow();let disposed=false,stop:(()=>void)|undefined;const sync=()=>win.isMaximized().then(value=>{if(!disposed)setMaximized(value);}).catch(e=>{if(!disposed)onError(String(e));});sync();win.onResized(sync).then(fn=>{if(disposed)fn();else stop=fn;});return()=>{disposed=true;stop?.();};},[native]);
  const action=async(kind:'minimize'|'maximize'|'close'|'drag')=>{if(!native)return;try{const win=getCurrentWindow();if(kind==='minimize')await win.minimize();if(kind==='maximize'){await win.toggleMaximize();setMaximized(await win.isMaximized());}if(kind==='close')await win.close();if(kind==='drag')await win.startDragging();}catch(e){onError(String(e));}};
  return <GlassChrome as="header" className="titlebar"><div className="titlebar-drag" onMouseDown={e=>{if(e.button===0)void action(e.detail===2?'maximize':'drag');}}><img src="/mono-white.svg" alt="" width={22} height={22} draggable={false}/><span>Mono Pack</span></div><div className="window-controls"><button type="button" aria-label="Minimize" title="Minimize" disabled={!native} onClick={()=>void action('minimize')}><Minus size={15}/></button><button type="button" aria-label={maximized?'Restore':'Maximize'} title={maximized?'Restore':'Maximize'} disabled={!native} onClick={()=>void action('maximize')}>{maximized?<Copy size={14}/>:<Square size={14}/>}</button><button type="button" className="window-close" aria-label="Close" title="Close" disabled={!native} onClick={()=>void action('close')}><X size={17}/></button></div></GlassChrome>;
}
