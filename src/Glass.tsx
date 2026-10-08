import {useEffect,useRef,useState,type HTMLAttributes,type RefObject,type Ref} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import './vendor/santi-glass.js';
import './vendor/mono-surfaces.js';
type GlassSystem={useLens:(ref:RefObject<HTMLElement|null>,options:{strong?:boolean;enabled?:boolean})=>void;useLiquidGlass:()=>[boolean,(on:boolean)=>void]};
const glass=(window as unknown as {SantiGlass:GlassSystem}).SantiGlass;
export function useWindowGlass(){useEffect(()=>{const stop=window.MonoSurfaces.install();if(isTauri())void invoke('set_liquid_glass',{on:false}).catch(console.error);return stop;},[]);}
export function GlassChrome({as='div',className='',children,...props}:HTMLAttributes<HTMLElement>&{as?:'div'|'aside'|'header'|'footer'}) {
  const ref=useRef<HTMLElement|null>(null),[behind,setBehind]=useState(false);
  useEffect(()=>{if(ref.current)return window.MonoSurfaces.watchSurface(ref.current,setBehind);},[]);
  glass.useLens(ref,{strong:true,enabled:behind});const Component=as;
  return <Component ref={ref as Ref<HTMLDivElement>} className={`sg-glass sg-glass-strong ${className}`} {...props}>{children}</Component>;
}
export function GlassToggle(){const [on,setGlass]=glass.useLiquidGlass();return <button type="button" role="switch" aria-checked={on} className="glass-toggle" onClick={()=>setGlass(!on)}><span>Liquid Glass</span><span className="toggle-track" aria-hidden="true"><span/></span></button>;}
