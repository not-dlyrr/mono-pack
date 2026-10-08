// Ease coarse wheel steps; preserve touch, trackpad inertia and keyboard scrolling.
export function installSmoothScrolling(){
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),pointer=matchMedia('(hover: hover) and (pointer: fine)');
  let frame=0,target:HTMLElement|null=null,position=0,destination=0,last=0;
  const stop=()=>{cancelAnimationFrame(frame);frame=0;target=null;};
  const tick=(now:number)=>{if(!target)return;const elapsed=Math.min(40,now-last);last=now;const max=Math.max(0,target.scrollHeight-target.clientHeight);destination=Math.max(0,Math.min(destination,max));position=Math.max(0,Math.min(position,max));position+=(destination-position)*(1-Math.exp(-elapsed/95));if(Math.abs(destination-position)<1){target.scrollTo({top:destination,behavior:'instant'});stop();return;}target.scrollTo({top:position,behavior:'instant'});frame=requestAnimationFrame(tick);};
  const wheel=(event:WheelEvent)=>{
    if(reduced.matches||!pointer.matches||event.defaultPrevented||event.ctrlKey||event.metaKey||event.shiftKey||Math.abs(event.deltaX)>=Math.abs(event.deltaY))return;
    if(event.deltaMode===0&&Math.abs(event.deltaY)<50){stop();return;}
    const origin=event.target instanceof Element?event.target:null;
    if(!origin||origin.closest('input,textarea,select,[contenteditable=true],[role=listbox]'))return;
    let next=document.scrollingElement as HTMLElement;
    for(let node:Element|null=origin;node&&node!==document.body;node=node.parentElement){if(node instanceof HTMLElement&&node.scrollHeight>node.clientHeight+1&&/(auto|scroll)/.test(getComputedStyle(node).overflowY)){next=node;break;}}
    if(next!==target){stop();target=next;position=destination=next.scrollTop;}
    const delta=event.deltaY*(event.deltaMode===1?20:event.deltaMode===2?next.clientHeight:1),max=Math.max(0,next.scrollHeight-next.clientHeight);
    const end=Math.max(0,Math.min(max,destination+delta));
    if(end===destination){if(frame)event.preventDefault();else stop();return;}
    event.preventDefault();destination=end;if(!frame){last=performance.now();frame=requestAnimationFrame(tick);}
  };
  const keyboard=(event:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))stop();};
  const visibility=()=>{if(document.hidden)stop();};
  window.addEventListener('wheel',wheel,{passive:false});document.addEventListener('pointerdown',stop,{passive:true});document.addEventListener('keydown',keyboard);document.addEventListener('visibilitychange',visibility);reduced.addEventListener('change',stop);
  return()=>{stop();window.removeEventListener('wheel',wheel);document.removeEventListener('pointerdown',stop);document.removeEventListener('keydown',keyboard);document.removeEventListener('visibilitychange',visibility);reduced.removeEventListener('change',stop);};
}

