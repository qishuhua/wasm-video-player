import {makeRenderer} from "./renderer.js";
const $=id=>document.getElementById(id);
const canvas=$("canvas"),panel=$("panel"),seek=$("seek"),play=$("play"),status=$("status");
const LIMIT=128*1024*1024, HIGH=8, LOW=3;
const modeSelect=$("decodeMode");
let activeEngine="none", selectedSource=null, native=null, objectURL=null, startupTimer=null,
    nativeIntent=false, fallbackReason="", resumeAt=0;
let renderer, worker, abort, loadId=0, generation=0, queue=[], inflight=false, ready=false,
    eof=false, playing=false, seeking=false, duration=0, current=0, rate=1, anchor=0,
    running=false, preview=false, dragging=false, lastFrame=null, framesShown=0, framesDropped=0;
const now=()=>performance.now()/1000;
function message(s,error=false){status.textContent=s;status.classList.toggle("error",error);}
function fmt(t){t=Math.max(0,Math.floor(t||0));let m=Math.floor(t/60),s=t%60;return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");}
function controls(){
  play.disabled=!ready;play.textContent=playing?"❚❚":"▶";
  seek.disabled=!ready||duration<=0;
  seek.max=duration||0;
  if(!dragging)seek.value=Math.min(current,duration||current);
  $("time").textContent=fmt(dragging?Number(seek.value):current)+" / "+fmt(duration);
}
function haltClock(){running=false;}
function startClock(){anchor=now()-current/rate;running=true;}
function error(e){
  stopNative();
  activeEngine="none";
  playing=false;ready=false;seeking=false;inflight=false;haltClock();queue=[];
  if(worker){worker.terminate();worker=null;}
  message(String(e.message||e),true);controls();
}
function pull(force=false){
  if(!worker||!ready||seeking||inflight||eof||(!playing&&!preview))return;
  if(!force&&queue.length>LOW)return;
  const count=Math.min(3,HIGH-queue.length);if(count<=0)return;
  inflight=true;worker.postMessage({type:"pull",generation,count});
}
function show(f){
  renderer.draw(f);current=f.pts;lastFrame=f;framesShown++;
  $("info").textContent=f.width+" × "+f.height+" | FFmpeg WASM CPU | "+renderer.name+
     " | 缓冲 "+queue.length+" 帧 | 已显示 "+framesShown+" | 跳过 "+framesDropped+
     (fallbackReason?" | 原生回退："+fallbackReason:"");
}
function handle(data){
  if(data.generation!==generation)return;
  if(data.type==="error"){error(data.message);return;}
  if(data.type==="opened"){
    ready=true;duration=Math.max(0,Number(data.duration)||0);preview=true;
    if(resumeAt>0&&duration>0){const t=resumeAt;resumeAt=0;jump(t);return;}
    message("视频已打开，正在解码首帧…");controls();pull(true);
  }else if(data.type==="seeked"){
    seeking=false;preview=true;pull(true);
  }else if(data.type==="frames"){
    inflight=false;eof=data.eof;queue.push(...data.frames);
    if(preview&&queue.length){
      try{show(queue.shift());}catch(e){error(e);return;}
      preview=false;haltClock();message(playing?"播放中":"已就绪");
      controls();
    }else if(preview&&eof){
      preview=false;playing=false;haltClock();message("目标时间后没有可显示的视频帧");controls();
    }
    pull();
  }
}
async function readURL(url,signal){
  const u=new URL(url,location.href);
  if(!["http:","https:"].includes(u.protocol))throw new Error("只接受 HTTP/HTTPS URL");
  const r=await fetch(u,{signal});
  if(!r.ok)throw new Error("HTTP "+r.status);
  const size=Number(r.headers.get("content-length"));
  if(size>LIMIT)throw new Error("视频超过 128 MiB");
  if(!r.body||!r.body.getReader){const b=await r.arrayBuffer();if(b.byteLength>LIMIT)throw new Error("视频超过 128 MiB");return b;}
  const reader=r.body.getReader(),chunks=[];let total=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;
      if(total>LIMIT){await reader.cancel();throw new Error("视频超过 128 MiB");}
      chunks.push(value);message("下载中 "+(total/1048576).toFixed(1)+" MiB");
    }
  }finally{reader.releaseLock();}
  const out=new Uint8Array(total);let pos=0;
  for(const c of chunks){out.set(c,pos);pos+=c.length;}return out.buffer;
}
function stopNative(){
  clearTimeout(startupTimer);startupTimer=null;
  const v=native;native=null;
  if(v){v.pause();v.removeAttribute("src");v.load();v.remove();}
  if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}
  canvas.hidden=false;
}
function syncNative(){
  const v=native;if(!v)return;
  current=Number.isFinite(v.currentTime)?v.currentTime:0;
  duration=Number.isFinite(v.duration)?v.duration:0;
  playing=!v.paused&&!v.ended;
  controls();
  const quality=typeof v.getVideoPlaybackQuality==="function"?v.getVideoPlaybackQuality():null;
  $("info").textContent=(v.videoWidth?v.videoWidth+" × "+v.videoHeight+" | ":"")+
    "浏览器原生解码（硬件/软件由浏览器决定）"+
    (quality?" | 视频帧 "+quality.totalVideoFrames+" | 丢帧 "+quality.droppedVideoFrames:"");
}
function failNative(reason,id,v){
  if(id!==loadId||v!==native)return;
  const position=Number.isFinite(v.currentTime)&&v.currentTime>0?v.currentTime:resumeAt;
  if(modeSelect.value==="auto"){
    load(selectedSource,nativeIntent,position,"software",reason);
  }else error("原生播放失败："+reason+"；可选择 CPU 软解重试。");
}
async function nativePlay(v,id){
  nativeIntent=true;
  try{await v.play();}
  catch(e){
    if(id!==loadId||native!==v)return;
    if(e.name==="NotSupportedError"){failNative(e.message||"不支持该视频",id,v);return;}
    if(e.name==="AbortError")return;
    nativeIntent=false;syncNative();
    message(e.name==="NotAllowedError"?"浏览器阻止自动播放，请点击播放":"播放失败："+e.message,e.name!=="NotAllowedError");
  }
}
function startNative(source,auto,id){
  activeEngine="native";nativeIntent=auto;
  const v=document.createElement("video");native=v;
  v.id="nativeVideo";v.muted=true;v.playsInline=true;v.preload="auto";
  v.setAttribute("playsinline","");v.setAttribute("webkit-playsinline","");
  v.disablePictureInPicture=true;
  v.playbackRate=rate;
  canvas.hidden=true;canvas.parentNode.insertBefore(v,canvas);
  const listen=(name,fn)=>v.addEventListener(name,()=>{if(id===loadId&&native===v)fn();});
  listen("loadedmetadata",()=>{
    ready=true;syncNative();
    if(resumeAt>0){
      try{v.currentTime=Math.min(resumeAt,Math.max(0,duration-0.05));}catch(_){}
      resumeAt=0;
    }
    v.playbackRate=rate;controls();
    if(nativeIntent)nativePlay(v,id);else message("原生视频已就绪");
  });
  function firstFrame(){clearTimeout(startupTimer);startupTimer=null;syncNative();}
  listen("loadeddata",firstFrame);listen("canplay",firstFrame);
  listen("playing",()=>{firstFrame();message("原生播放中");});
  listen("play",syncNative);
  listen("pause",()=>{syncNative();if(!v.ended&&!v.error)message("已暂停");});
  listen("timeupdate",syncNative);listen("durationchange",syncNative);
  listen("seeked",()=>{syncNative();if(v.paused)message("已暂停");});
  listen("waiting",()=>{if(nativeIntent)message("原生视频缓冲中…");});
  listen("ended",()=>{nativeIntent=false;syncNative();message("播放结束");});
  listen("error",()=>{
    const e=v.error;
    failNative(e?(e.message||"MediaError "+e.code):"原生媒体加载失败",id,v);
  });
  v.onclick=toggle;
  message("正在尝试浏览器原生解码…");
  startupTimer=setTimeout(()=>failNative("20 秒内未获得首帧",id,v),20000);
  if(source instanceof File){objectURL=URL.createObjectURL(source);v.src=objectURL;}
  else v.src=source;
  v.load();
}
async function load(source,auto=false,position=0,override="",reason=""){
  const id=++loadId;generation++;if(abort)abort.abort();abort=new AbortController();
  if(worker)worker.terminate();worker=null;stopNative();
  selectedSource=source;fallbackReason=reason;resumeAt=position;activeEngine="none";
  queue=[];inflight=ready=eof=seeking=preview=false;playing=auto;dragging=false;haltClock();
  current=duration=framesShown=framesDropped=0;lastFrame=null;controls();$("info").textContent="";
  try{
    if(!(source instanceof File)){
      const url=new URL(source,location.href);
      if(!["http:","https:"].includes(url.protocol))throw new Error("只接受 HTTP/HTTPS URL");
      source=url.href;selectedSource=source;
    }
    const mode=override||modeSelect.value;
    if(mode!=="software"){startNative(source,auto,id);return;}
    activeEngine="software";
    if(!window.WebAssembly)throw new Error("浏览器不支持 WebAssembly");
    if(!renderer)renderer=makeRenderer(canvas);
    message((reason?"原生播放失败，切换 CPU 软解："+reason+"；":"")+"正在读取视频…");
    let buffer;
    if(source instanceof File){
      if(source.size>LIMIT)throw new Error("CPU 软解模式视频超过 128 MiB");
      buffer=await source.arrayBuffer();
    }else buffer=await readURL(source,abort.signal);
    if(id!==loadId)return;
    message("正在加载 FFmpeg WASM 解码器…");
    worker=new Worker("./decoder.worker.js");
    worker.onmessage=e=>{if(id===loadId)handle(e.data);};
    worker.onerror=e=>{if(id===loadId)error(e.message||"WASM 加载失败");};
    worker.postMessage({type:"open",generation,buffer},[buffer]);
  }catch(e){if(id===loadId&&e.name!=="AbortError")error((reason?"原生失败："+reason+"；CPU 软解失败：":"")+String(e.message||e));}
}
function jump(t){
  if(activeEngine==="native"&&native&&ready&&duration){native.currentTime=Math.max(0,Math.min(t,duration));syncNative();return;}
  if(!ready||!worker||!duration)return;
  t=Math.max(0,Math.min(t,Math.max(0,duration-0.05)));
  generation++;queue=[];inflight=false;eof=false;seeking=true;preview=true;
  current=t;haltClock();message("正在定位关键帧…");controls();
  worker.postMessage({type:"seek",generation,seconds:t});
}
function toggle(){
  if(!ready)return;
  if(activeEngine==="native"&&native){
    if(native.paused||native.ended)nativePlay(native,loadId);
    else{nativeIntent=false;native.pause();}
    return;
  }
  if(eof&&!queue.length&&!playing){playing=true;jump(0);return;}
  playing=!playing;haltClock();controls();
  if(playing){message("播放中");pull(true);}else message("已暂停");
}
function tick(){
  requestAnimationFrame(tick);
  if(activeEngine==="native"){if(native&&ready&&playing)syncNative();return;}
  if(activeEngine!=="software"||!playing||!ready||seeking||preview)return;
  if(!queue.length){
    haltClock();
    if(eof){playing=false;message("播放结束");controls();}
    else{message("解码缓冲中…");pull(true);}
    return;
  }
  if(!running)startClock();
  const t=(now()-anchor)*rate;
  let latest=null;
  while(queue.length&&queue[0].pts<=t+0.002){if(latest)framesDropped++;latest=queue.shift();}
  if(latest){try{show(latest);}catch(e){error(e);return;}controls();}
  pull();
}
$("load").onclick=()=>{const url=$("url").value.trim();if(url)load(url,true);};
$("url").onkeydown=e=>{if(e.key==="Enter")$("load").click();};
$("file").onchange=e=>{if(e.target.files[0])load(e.target.files[0],true);};
play.onclick=toggle;
seek.oninput=()=>{dragging=true;controls();};
seek.onchange=()=>{const t=Number(seek.value);dragging=false;jump(t);};
$("speed").onchange=e=>{rate=Number(e.target.value);if(native)native.playbackRate=rate;haltClock();};
modeSelect.onchange=()=>{
  if(selectedSource!==null){
    const auto=activeEngine==="native"?nativeIntent:playing;
    const t=activeEngine==="native"&&native?native.currentTime:current;
    load(selectedSource,auto,Number.isFinite(t)?t:0);
  }
};
$("full").onclick=async()=>{
  if(document.fullscreenElement){await document.exitFullscreen();return;}
  if(panel.classList.contains("full")){panel.classList.remove("full");return;}
  try{if(panel.requestFullscreen){await panel.requestFullscreen();return;}}catch(_){}
  panel.classList.add("full");
};
document.addEventListener("keydown",e=>{if(e.key==="Escape")panel.classList.remove("full");});
canvas.onclick=toggle;
const q=new URLSearchParams(location.search);
const requestedMode=(q.get("mode")||"auto").toLowerCase();
modeSelect.value=["auto","native","software"].includes(requestedMode)?requestedMode:"auto";
const svg=q.get("svg")||q.get("overlay");
if(svg){try{const u=new URL(svg,location.href);if(["https:","http:"].includes(u.protocol)){$("overlay").src=u.href;$("overlay").hidden=false;}}catch(_){}}
if(q.get("video")){$("url").value=q.get("video");load(q.get("video"),q.get("autoplay")==="1");}
controls();requestAnimationFrame(tick);
