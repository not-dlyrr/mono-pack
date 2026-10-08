import {useLayoutEffect,useRef,type ReactNode} from 'react';

const timing={duration:180,easing:'cubic-bezier(.22,.8,.2,1)'};
// Keep one indicator, retarget from its current visual position, and never stretch it.
export function SpringGroup({value,className,children}:{value:string;className:string;children:ReactNode}) {
 const group=useRef<HTMLDivElement>(null),indicator=useRef<HTMLSpanElement>(null),update=useRef<()=>void>(()=>{});
 useLayoutEffect(()=>{
  const root=group.current!,pill=indicator.current!,reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let initialized=false,animation:Animation|null=null;
  function measure(){
   const target=root.querySelector<HTMLElement>('[aria-pressed="true"],.selected');if(!target)return;
   const style=getComputedStyle(pill),from={transform:style.transform,width:style.width,height:style.height};
   const to={transform:`translate3d(${target.offsetLeft}px,${target.offsetTop}px,0)`,width:target.offsetWidth+'px',height:target.offsetHeight+'px'};
   const changed=from.transform!==new DOMMatrixReadOnly(to.transform).toString()||parseFloat(from.width)!==target.offsetWidth||parseFloat(from.height)!==target.offsetHeight;
   animation?.cancel();Object.assign(pill.style,to);root.dataset.springMoving='false';
   if(initialized&&changed&&!reduced.matches&&!document.hidden){
    root.dataset.springMoving='true';const current=pill.animate([from,to],timing);animation=current;
    current.finished.then(()=>{if(animation===current){root.dataset.springMoving='false';animation=null;}}).catch(()=>{});
   }
   initialized=true;
  }
  const settle=()=>{animation?.cancel();animation=null;measure();};
  update.current=measure;measure();const resize=new ResizeObserver(measure);resize.observe(root);
  reduced.addEventListener('change',settle);document.addEventListener('visibilitychange',settle);
  return()=>{animation?.cancel();resize.disconnect();reduced.removeEventListener('change',settle);document.removeEventListener('visibilitychange',settle);update.current=()=>{};};
 },[]);
 useLayoutEffect(()=>update.current(),[value]);
 return <div ref={group} className={className+' spring-group'}><span className="spring-selection-mask" aria-hidden="true"><span ref={indicator} className="spring-selection"/></span>{children}</div>;
}

export function useSpringContent(value:string,_order:string[],_distance=4){
 const ref=useRef<HTMLDivElement>(null),previous=useRef(value),animation=useRef<Animation|null>(null);
 useLayoutEffect(()=>{
  if(previous.current===value)return;previous.current=value;const el=ref.current;if(!el)return;
  animation.current?.cancel();
  if(!document.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches)
   animation.current=el.animate([{opacity:.9,translate:'0 4px'},{opacity:1,translate:'0 0'}],{...timing,duration:160});
 },[value]);
 useLayoutEffect(()=>{
  const media=matchMedia('(prefers-reduced-motion: reduce)'),cancel=()=>{if(media.matches||document.hidden)animation.current?.cancel();};
  media.addEventListener('change',cancel);document.addEventListener('visibilitychange',cancel);
  return()=>{animation.current?.cancel();media.removeEventListener('change',cancel);document.removeEventListener('visibilitychange',cancel);};
 },[]);
 return ref;
}
