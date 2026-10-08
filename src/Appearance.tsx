import {useEffect,useRef,useState} from 'react';
import {Contrast,ChevronDown} from 'lucide-react';
import {GlassChrome,GlassToggle} from './Glass';
import {SpringGroup} from './Motion';
import './appearance.css';

type Theme='light'|'dark';
const key='mono.pack.theme';
export function initializeAppearance(){
  let theme:Theme='dark';
  try{const saved=localStorage.getItem(key);if(saved==='light'||saved==='dark')theme=saved;}catch{}
  document.documentElement.dataset.theme=theme;
}
export function Appearance(){
  const [open,setOpen]=useState(false),[theme,setTheme]=useState<Theme>(document.documentElement.dataset.theme==='light'?'light':'dark');
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const keyboard=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',keyboard);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keyboard);};
  },[open]);
  useEffect(()=>{const sync=(event:StorageEvent)=>{if(event.key===key&&(event.newValue==='light'||event.newValue==='dark')){document.documentElement.dataset.theme=event.newValue;setTheme(event.newValue);}};window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);},[]);
  const choose=(value:Theme)=>{setTheme(value);document.documentElement.dataset.theme=value;try{localStorage.setItem(key,value);}catch{}};
  return <div ref={root} className="appearance" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setOpen(false);}}><button ref={trigger} type="button" className="appearance-trigger" aria-expanded={open} aria-controls="appearance-panel" onClick={()=>setOpen(!open)}><Contrast size={16}/><span>Appearance</span><ChevronDown size={14}/></button>{open&&<GlassChrome className="appearance-panel" id="appearance-panel" role="region" aria-label="Appearance preferences"><h2>Preferences</h2><div className="appearance-theme"><span>Theme</span><SpringGroup className="appearance-segment" value={theme}><button type="button" className={theme==='light'?'selected':''} aria-pressed={theme==='light'} onClick={()=>choose('light')}>Light</button><button type="button" className={theme==='dark'?'selected':''} aria-pressed={theme==='dark'} onClick={()=>choose('dark')}>Dark</button></SpringGroup></div><GlassToggle/><p>Respects reduced motion and transparency preferences.</p></GlassChrome>}</div>;
}

