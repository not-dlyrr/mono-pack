/* Shared Mono surface policy and authored scrollbars. No desktop sampling.
   Native scrolling remains the source of truth; every track/thumb is our DOM. */
(function () {
  'use strict';
  if (window.MonoSurfaces) return;
  var surfaces = new Map(), bars = new Map(), users = 0, frame = 0, uid = 0;
  var observer, resizeObserver, layer, dirty = true, candidates = [], motionUntil=0;
  var ignored = '[data-mono-runtime],.sg-lens-layer,script,style,noscript,svg defs';
  function outsideRuntime(el) { return el instanceof Element && !el.closest(ignored); }
  function intersection(a, b) {
    var left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
    var right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
    return right > left && bottom > top ? {left:left,top:top,right:right,bottom:bottom,width:right-left,height:bottom-top} : null;
  }
  function visible(el) {
    if (!el.isConnected) return false;
    var style = getComputedStyle(el);
    if (style.visibility !== 'visible' || style.display === 'none' || +style.opacity === 0) return false;
    return !el.checkVisibility || el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  }
  function collectContent() {
    candidates = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode:function (node) {
        return node.textContent.trim() && outsideRuntime(node.parentElement) &&
          !node.parentElement.closest('svg') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    while (walker.nextNode()) candidates.push({node:walker.currentNode,el:walker.currentNode.parentElement});
    document.querySelectorAll('img,video,canvas,svg,button,input,textarea').forEach(function (el) {
      if (outsideRuntime(el) && !el.closest('svg svg') && !el.matches('input[type=hidden]') &&
          (!el.matches('svg') || el.getBoundingClientRect().width > 0))
        candidates.push({el:el});
    });
    dirty = false;
  }
  function opaque(el) {
    var style = getComputedStyle(el), color = style.backgroundColor;
    var alpha = color === 'transparent' ? 0 : color.startsWith('rgba') ?
      parseFloat(color.split(',').pop()) : color.startsWith('rgb') ? 1 : 0;
    return +style.opacity >= .98 && (alpha >= .98 || style.backgroundImage !== 'none');
  }
  function paintedBehind(surface, candidate, rect) {
    var points = [[.5,.5],[.2,.5],[.8,.5]];
    return points.some(function (point) {
      var x = rect.left + rect.width * point[0], y = rect.top + rect.height * point[1];
      var stack = document.elementsFromPoint(x,y);
      var surfaceIndex = stack.findIndex(function (el) { return el === surface || surface.contains(el); });
      var contentIndex = stack.findIndex(function (el) { return el === candidate || candidate.contains(el); });
      if (surfaceIndex < 0 || contentIndex <= surfaceIndex) return false;
      for (var i=surfaceIndex+1;i<contentIndex;i++) {
        var el=stack[i];
        if (el.contains(candidate) || candidate.contains(el) || surface.contains(el)) continue;
        if (opaque(el)) return false;
      }
      return true;
    });
  }
  function contentBehind(surface) {
    if (!visible(surface)) return false;
    var area = intersection(surface.getBoundingClientRect(),{left:0,top:0,right:innerWidth,bottom:innerHeight});
    if (!area || area.width < 1 || area.height < 1) return false;
    var range = document.createRange();
    return candidates.some(function (candidate) {
      var el = candidate.el;
      if (surface.contains(el) || el.contains(surface) || !visible(el) ||
          !intersection(el.getBoundingClientRect(),area)) return false;
      if (candidate.node) {
        if (!candidate.node.isConnected) return false;
        range.selectNodeContents(candidate.node);
        return Array.from(range.getClientRects()).some(function (rect) {
          var overlap=intersection(rect,area);
          return overlap && paintedBehind(surface,el,overlap);
        });
      }
      var overlap = intersection(el.getBoundingClientRect(),area);
      return overlap && paintedBehind(surface,el,overlap);
    });
  }
  function setBehind(record, behind) {
    if (record.behind === behind) return;
    record.behind = behind;
    record.el.dataset.contentBehind = String(behind);
    record.listeners.forEach(function (listener) { listener(behind); });
  }
  function watchSurface(el, listener) {
    var record=surfaces.get(el);
    if (!record) {
      record={el:el,behind:false,listeners:new Set(),auto:false};
      surfaces.set(el,record);
      el.dataset.contentBehind='false';
    }
    if (listener) {record.listeners.add(listener);listener(record.behind);}
    schedule();
    return function () {
      if (listener) record.listeners.delete(listener);
      if (!record.auto && !record.listeners.size) surfaces.delete(el);
    };
  }
  function geometry(target) {
    if (target === document.scrollingElement) return {left:0,top:0,right:innerWidth,bottom:innerHeight,width:innerWidth,height:innerHeight};
    var rect=target.getBoundingClientRect();
    var sx=target.offsetWidth?rect.width/target.offsetWidth:1,sy=target.offsetHeight?rect.height/target.offsetHeight:1;
    var box={left:rect.left+target.clientLeft*sx,top:rect.top+target.clientTop*sy,
      right:rect.left+(target.clientLeft+target.clientWidth)*sx,bottom:rect.top+(target.clientTop+target.clientHeight)*sy,
      width:target.clientWidth*sx,height:target.clientHeight*sy};
    for (var parent=target.parentElement;parent && parent!==document.body;parent=parent.parentElement) {
      var style=getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX+' '+style.overflowY)) {
        box=intersection(box,parent.getBoundingClientRect());
        if (!box) return null;
      }
    }
    return intersection(box,{left:0,top:0,right:innerWidth,bottom:innerHeight});
  }
  function axisValue(record, axis) {
    var el=record.target, vertical=axis==='y';
    var size=vertical?el.clientHeight:el.clientWidth;
    if (el===document.scrollingElement) size=vertical?innerHeight:innerWidth;
    var extent=vertical?el.scrollHeight:el.scrollWidth;
    var rtl=!vertical && getComputedStyle(el).direction==='rtl';
    return {size:size,max:Math.max(0,extent-size),value:vertical?el.scrollTop:rtl?-el.scrollLeft:el.scrollLeft,rtl:rtl};
  }
  function setScroll(record, axis, value) {
    var info=axisValue(record,axis), next=Math.min(info.max,Math.max(0,value));
    record.target.scrollTo({
      top:axis==='y'?next:record.target.scrollTop,
      left:axis==='x'?(info.rtl?-next:next):record.target.scrollLeft,
      behavior:'instant'
    });
    schedule();
  }
  function makeAxis(record, axis) {
    var track=document.createElement('div'),thumb=document.createElement('div'),ink=document.createElement('span');
    track.className='mono-scroll-track';track.dataset.axis=axis;track.dataset.monoRuntime='';
    thumb.className='mono-scroll-thumb';thumb.tabIndex=0;
    thumb.setAttribute('role','scrollbar');thumb.setAttribute('aria-controls',record.target.id);
    thumb.setAttribute('aria-orientation',axis==='y'?'vertical':'horizontal');
    thumb.setAttribute('aria-valuemin','0');
    var label=record.target.getAttribute('aria-label');
    if (!label) {
      var heading=record.target.querySelector('h1,h2,h3');
      label=heading?heading.textContent.trim():record.target===document.scrollingElement?'Page':'Content';
    }
    thumb.setAttribute('aria-label',(axis==='y'?'Vertical':'Horizontal')+' scroll: '+label);
    ink.className='mono-scroll-thumb-ink';ink.setAttribute('aria-hidden','true');
    thumb.appendChild(ink);track.appendChild(thumb);layer.appendChild(track);
    var item={track:track,thumb:thumb,length:0,thumbLength:0,drag:null};
    thumb.addEventListener('keydown',function (event) {
      var info=axisValue(record,axis),delta=0,absolute;
      if (event.key==='Home') absolute=0;
      else if (event.key==='End') absolute=info.max;
      else if (event.key==='PageDown' || event.key===' ') delta=(event.shiftKey?-1:1)*info.size*.9;
      else if (event.key==='PageUp') delta=-info.size*.9;
      else if (event.key===(axis==='y'?'ArrowDown':'ArrowRight')) delta=axis==='x'&&info.rtl?-48:48;
      else if (event.key===(axis==='y'?'ArrowUp':'ArrowLeft')) delta=axis==='x'&&info.rtl?48:-48;
      else return;
      event.preventDefault();event.stopPropagation();
      setScroll(record,axis,absolute===undefined?info.value+delta:absolute);
    });
    thumb.addEventListener('pointerdown',function (event) {
      if (event.button!==0) return;
      event.preventDefault();event.stopPropagation();thumb.focus({preventScroll:true});
      item.drag={pointer:event.pointerId,start:axis==='y'?event.clientY:event.clientX,value:axisValue(record,axis).value};
      thumb.setPointerCapture(event.pointerId);track.classList.add('is-dragging');
    });
    thumb.addEventListener('pointermove',function (event) {
      if (!item.drag || event.pointerId!==item.drag.pointer) return;
      var delta=(axis==='y'?event.clientY:event.clientX)-item.drag.start;
      setScroll(record,axis,item.drag.value+delta*axisValue(record,axis).max/Math.max(1,(item.length-item.thumbLength)*(item.scale||1)));
    });
    function release() {item.drag=null;track.classList.remove('is-dragging');}
    thumb.addEventListener('pointerup',release);thumb.addEventListener('pointercancel',release);thumb.addEventListener('lostpointercapture',release);
    track.addEventListener('pointerdown',function (event) {
      if (event.button!==0 || thumb.contains(event.target)) return;
      event.preventDefault();thumb.focus({preventScroll:true});
      var info=axisValue(record,axis),rect=thumb.getBoundingClientRect();
      var before=axis==='y'?event.clientY<rect.top:event.clientX<rect.left;
      setScroll(record,axis,info.value+(before?-1:1)*info.size*.9);
    });
    track.addEventListener('wheel',function (event) {
      if (event.ctrlKey || event.metaKey) return;
      var info=axisValue(record,axis),delta=axis==='y'?event.deltaY:(event.deltaX || event.deltaY);
      if (event.deltaMode===1) delta*=24;
      if (event.deltaMode===2) delta*=info.size;
      if (delta && (delta>0?info.value<info.max:info.value>0)) {
        event.preventDefault();setScroll(record,axis,info.value+delta);
      }
    },{passive:false});
    return item;
  }
  function removeBar(record) {
    Object.keys(record.axes).forEach(function (axis) {record.axes[axis].track.remove();});
    resizeObserver.unobserve(record.target);
    if (record.child) resizeObserver.unobserve(record.child);
    if (record.ownId && record.target.id===record.ownId) record.target.removeAttribute('id');
    bars.delete(record.target);
  }
  function scan() {
    document.querySelectorAll('.sg-glass,[data-mono-glass]').forEach(function (el) {
      if (!outsideRuntime(el)) return;
      if (!surfaces.has(el)) watchSurface(el);
      surfaces.get(el).auto=true;
    });
    var targets=new Map(), scrolling=document.scrollingElement;
    if (scrolling) targets.set(scrolling,{x:true,y:true});
    var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT,{
      acceptNode:function (el) {
        if (el.closest('[data-mono-runtime]') || el.namespaceURI!=='http://www.w3.org/1999/xhtml') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      var el=walker.currentNode;
      if (el===scrolling || !visible(el)) continue;
      var style=getComputedStyle(el),x=/(auto|scroll)/.test(style.overflowX),y=/(auto|scroll)/.test(style.overflowY);
      if ((x && el.scrollWidth>el.clientWidth+1) || (y && el.scrollHeight>el.clientHeight+1)) targets.set(el,{x:x,y:y});
    }
    bars.forEach(function (record,target) {if (!targets.has(target) || !target.isConnected) removeBar(record);});
    targets.forEach(function (axes,target) {
      var record=bars.get(target);
      if (!record) {
        var ownId=target.id?'':'mono-scroll-'+(++uid);
        if (ownId) target.id=ownId;
        record={target:target,ownId:ownId,axes:{},child:target.firstElementChild};
        bars.set(target,record);resizeObserver.observe(target);
        if (record.child) resizeObserver.observe(record.child);
      }
      ['x','y'].forEach(function (axis) {
        if (axes[axis] && axisValue(record,axis).max>1 && !record.axes[axis]) record.axes[axis]=makeAxis(record,axis);
        else if ((!axes[axis] || axisValue(record,axis).max<=1) && record.axes[axis]) {
          record.axes[axis].track.remove();delete record.axes[axis];
        }
      });
    });
  }
  // Tracks share their owner's paint level; a background scrollbar must not
  // sit above a popup, while that popup's own scrollbar stays interactive.
  function scrollbarLevel(target, boundary) {
    var level=0;
    for (var el=target;el && el!==boundary && el!==document.body && el!==document.documentElement;el=el.parentElement) {
      var style=getComputedStyle(el),z=style.zIndex;
      var parentStyle=el.parentElement?getComputedStyle(el.parentElement):null;
      var positioned=style.position!=='static' || (parentStyle && /flex|grid/.test(parentStyle.display));
      if (z!=='auto' && positioned) level=Number(z)||0;
      else if (style.transform!=='none' || style.isolation==='isolate' || Number(style.opacity)<1) level=0;
    }
    return level+1;
  }
  // A modal dialog is in the browser's top layer. Its bars must belong to that
  // layer too; ordinary document z-indices cannot put them above the dialog.
  function scrollbarPortal(target) {return target.closest('dialog[open]') || layer;}
  function portalSpace(portal) {
    if(portal===layer)return {left:0,top:0,sx:1,sy:1};
    for(var el=portal;el && el!==document.documentElement;el=el.parentElement){
      var style=getComputedStyle(el);
      var contains=style.position!=='static' || style.transform!=='none' || style.translate!=='none' || style.scale!=='none' || style.rotate!=='none' ||
        style.perspective!=='none' || style.filter!=='none' || style.backdropFilter!=='none' ||
        /layout|paint|strict|content/.test(style.contain) || /transform|translate|scale|rotate|filter|perspective/.test(style.willChange);
      if(contains){
        var rect=el.getBoundingClientRect(),sx=el.offsetWidth?rect.width/el.offsetWidth:1,sy=el.offsetHeight?rect.height/el.offsetHeight:1;
        return {left:rect.left+(el.clientLeft-el.scrollLeft)*sx,top:rect.top+(el.clientTop-el.scrollTop)*sy,sx:sx||1,sy:sy||1};
      }
      if(el.matches('dialog:modal'))break;
    }
    return {left:0,top:0,sx:1,sy:1};
  }
  function updateBars() {
    bars.forEach(function (record) {
      var box=geometry(record.target),portal=scrollbarPortal(record.target),space=portalSpace(portal),level=scrollbarLevel(record.target,portal===layer?null:portal);
      if(box){
        box={left:(box.left-space.left)/space.sx,top:(box.top-space.top)/space.sy,
          right:(box.right-space.left)/space.sx,bottom:(box.bottom-space.top)/space.sy,width:box.width/space.sx,height:box.height/space.sy};
      }
      Object.keys(record.axes).forEach(function (axis) {
        var item=record.axes[axis],info=axisValue(record,axis);
        if(item.track.parentElement!==portal)portal.appendChild(item.track);
        item.track.style.position=portal===layer?'fixed':'absolute';
        item.track.style.zIndex=String(level);
        var show=box && visible(record.target) && info.max>1;
        if (!show) {item.track.hidden=true;return;}
        var vertical=axis==='y', other=record.axes[vertical?'x':'y']?18:0;
        var length=(vertical?box.height:box.width)-8-other;
        if (length<24) {item.track.hidden=true;return;}
        item.track.hidden=false;item.length=length;item.scale=vertical?space.sy:space.sx;
        item.thumbLength=Math.min(length,Math.max(44,length*info.size/(info.max+info.size)));
        var value=Math.min(info.max,Math.max(0,info.value)),offset=value/info.max*(length-item.thumbLength);
        item.track.style.left=(vertical?box.right-18:box.left+4)+'px';
        item.track.style.top=(vertical?box.top+4:box.bottom-18)+'px';
        item.track.style.width=(vertical?18:length)+'px';item.track.style.height=(vertical?length:18)+'px';
        item.thumb.style.width=(vertical?18:item.thumbLength)+'px';item.thumb.style.height=(vertical?item.thumbLength:18)+'px';
        item.thumb.style.transform='translate'+(vertical?'Y':'X')+'('+offset+'px)';
        item.thumb.setAttribute('aria-valuemax',String(Math.round(info.max)));
        item.thumb.setAttribute('aria-valuenow',String(Math.round(value)));
        item.thumb.setAttribute('aria-valuetext',Math.round(value/info.max*100)+'%');
      });
    });
  }
  function update() {
    frame=0;
    if (!users) return;
    if (dirty) {scan();collectContent();}
    surfaces.forEach(function (record,el) {
      if (!el.isConnected) {surfaces.delete(el);return;}
      setBehind(record,contentBehind(el));
    });
    updateBars();
    if(performance.now()<motionUntil)schedule();
  }
  function schedule() {if (users && !frame) frame=requestAnimationFrame(update);}
  function rescan() {dirty=true;schedule();}
  function motion(event) {
    var el=event.target;
    if(!outsideRuntime(el)||el.closest('svg'))return;
    var style=getComputedStyle(el),animation=event.type==='animationstart';
    if(animation&&style.animationIterationCount.split(',').some(function(value){return value.trim()==='infinite'}))return;
    function longest(value){return Math.max.apply(Math,value.split(',').map(function(part){return parseFloat(part)*(part.trim().endsWith('ms')?1:1000)||0}));}
    var duration=longest(animation?style.animationDuration:style.transitionDuration);
    var delay=longest(animation?style.animationDelay:style.transitionDelay);
    motionUntil=Math.max(motionUntil,performance.now()+Math.min(3000,Math.max(0,duration+delay))+34);
    rescan();
  }
  function install() {
    users++;
    if (users===1) {
      layer=document.createElement('div');layer.className='mono-scrollbar-layer';layer.dataset.monoRuntime='';
      document.body.appendChild(layer);
      document.documentElement.classList.add('mono-scrollbars');
      resizeObserver=new ResizeObserver(rescan);
      observer=new MutationObserver(function (changes) {
        if (changes.some(function (change) {
          var el=change.target instanceof Element?change.target:change.target.parentElement;
          if (!outsideRuntime(el) || el.closest('svg')) return false;
          if (change.type==='attributes') return ['class','style','hidden','open'].includes(change.attributeName);
          if (change.type==='childList') return Array.from(change.addedNodes).concat(Array.from(change.removedNodes)).some(function (node) {
            return !(node instanceof Element) || !node.matches('.sg-lens-layer,svg,[data-mono-runtime]');
          });
          return true;
        })) rescan();
      });
      observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','open']});
      window.addEventListener('scroll',schedule,true);window.addEventListener('resize',rescan);
      document.addEventListener('load',rescan,true);
      document.addEventListener('animationend',rescan,true);
      document.addEventListener('transitionend',rescan,true);
      document.addEventListener('animationstart',motion,true);
      document.addEventListener('transitionrun',motion,true);
      if (document.fonts) document.fonts.addEventListener('loadingdone',rescan);
      dirty=true;schedule();
    }
    var done=false;
    return function () {
      if (done) return;done=true;users--;
      if (users) return;
      observer.disconnect();resizeObserver.disconnect();cancelAnimationFrame(frame);frame=0;
      window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',rescan);
      document.removeEventListener('load',rescan,true);
      document.removeEventListener('animationend',rescan,true);
      document.removeEventListener('transitionend',rescan,true);
      document.removeEventListener('animationstart',motion,true);
      document.removeEventListener('transitionrun',motion,true);motionUntil=0;
      if (document.fonts) document.fonts.removeEventListener('loadingdone',rescan);
      bars.forEach(removeBar);layer.remove();
      document.documentElement.classList.remove('mono-scrollbars');
      surfaces.forEach(function (record,el) {setBehind(record,false);if (record.auto && !record.listeners.size) surfaces.delete(el);});
    };
  }
  window.MonoSurfaces={install:install,watchSurface:watchSurface,refresh:rescan};
})();
