import React, {useEffect,useMemo,useRef,useState} from "react";
import {createUserWithEmailAndPassword,onAuthStateChanged,sendPasswordResetEmail,signInWithEmailAndPassword,signOut,User} from "firebase/auth";
import {addDoc,collection,deleteDoc,doc,getDoc,getDocs,increment,limit,onSnapshot,orderBy,query,serverTimestamp,setDoc,where,writeBatch} from "firebase/firestore";
import {getDownloadURL,getStorage,ref as storageRef,uploadBytes} from "firebase/storage";
import {profileAuth,profileDb} from "../firebase/profileFirebase";
import {MAX_MESSAGES,MAX_POSTS,MAX_REPLIES_PER_MESSAGE,detectContacts,mediaTypeFromUrl,normalizeUsername,validMediaUrl,validUsername} from "./validators";
import {encryptMessage,decryptMessage,getDeviceId} from "./crypto";
import "./profile.css";

/* ------------------------------------------------------------------ *
 * Premium — Firebase Storage reuses the same app as profileAuth, so
 * no change to the firebase config file is needed. The Paystack link
 * below is a real Payment Page link
 * (or generate one per-user server-side later if you want a reference
 * tied to the visit). Paystack is configured to redirect back to
 * "<your site>/profile/" after a successful
 * payment; that special "username" is intercepted in the root
 * component below and confirms the upgrade instead of loading a
 * public profile.
 * ------------------------------------------------------------------ */
const profileStorage=getStorage(profileAuth.app);
const PAYSTACK_UPGRADE_URL="https://paystack.shop/pay/bv5n43khmv";

/* Text limits (set here, not in validators). Messages and replies: 1-2500. Comments: 1-1000.
 * Longer text is clamped on screen: the first CLAMP_CHARS characters show, then "See more".
 * If your Firestore rules also cap text length, raise them to match. */
const MSG_MIN=1,MSG_MAX=2500;
const COMMENT_MIN=1,COMMENT_MAX=1000;
const CLAMP_CHARS=500;

/* Support on WhatsApp — the number is never shown; users only see "Contact support".
 * wa.me needs the number in international format, so set SUPPORT_COUNTRY_CODE
 * (digits only, e.g. "234" or "60") — it replaces the leading 0 of the local number. */
const SUPPORT_WHATSAPP="0182322555";
const SUPPORT_COUNTRY_CODE="254";
function supportUrl(text:string){
 const local=SUPPORT_WHATSAPP.replace(/\D/g,"");
 const intl=SUPPORT_COUNTRY_CODE?SUPPORT_COUNTRY_CODE+local.replace(/^0+/,""):local;
 return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

/* ------------------------------------------------------------------ *
 * Errors, app-wide
 *  - Firebase permission errors / disabled sign-in never show raw Firebase text. First time
 *    the user sees "Something went wrong, try again." If the SAME error keeps happening
 *    (ACCESS_ERR_LIMIT in a row, per browser session) they're pointed to Contact support.
 *    Use fail(toast,x,"Unable to …") in catch blocks and accessText(e,…) in passive listeners.
 *  - Restricted account: every time the dashboard opens, the signed-in UID is checked against
 *    its profile in Firestore (checkAccount). If it isn't found there, the flag notice shows.
 * ------------------------------------------------------------------ */
const ACCESS_GENERIC="Something went wrong, try again.";
const ACCESS_PERSIST="Still not working. Contact support for help.";
const ACCESS_ERR_LIMIT=2;
const ACCESS_ERR_WINDOW_MS=10*60*1000; // a streak older than this starts over
const ACCESS_ERR_DEDUPE_MS=1500;       // several listeners failing at once count as one
const ACCESS_ERR_KEY="spts_access_err_v1";
const FIREBASE_ACCESS_CODES=new Set([
 "permission-denied","unauthenticated",                             // Firestore rules
 "auth/operation-not-allowed","auth/admin-restricted-operation",    // sign-in method disabled
 "auth/configuration-not-found","auth/user-disabled",               // auth turned off / account disabled
]);
function firebaseAccessCode(x:any):string|null{
 const c=String(x?.code||"");
 if(FIREBASE_ACCESS_CODES.has(c))return c;
 if(/missing or insufficient permissions/i.test(String(x?.message||"")))return "permission-denied";
 return null;
}
type ErrStreak={code:string;n:number;at:number};
let _errMem:ErrStreak|null=null; // fallback if sessionStorage is blocked
let _lastAccessCode="";
function noteAccessError(code:string|null):boolean{ // true once the same error has repeated enough
 const now=Date.now();
 let prev=_errMem;
 try{ const r=sessionStorage.getItem(ACCESS_ERR_KEY); if(r)prev=JSON.parse(r); }catch{}
 let next:ErrStreak|null=null; // any other outcome resets the streak
 if(code){
  const same=!!prev&&prev.code===code&&now-prev.at<=ACCESS_ERR_WINDOW_MS;
  const dup=same&&now-prev!.at<ACCESS_ERR_DEDUPE_MS;
  next={code,n:same?(dup?prev!.n:prev!.n+1):1,at:dup?prev!.at:now};
 }
 _errMem=next;
 try{ next?sessionStorage.setItem(ACCESS_ERR_KEY,JSON.stringify(next)):sessionStorage.removeItem(ACCESS_ERR_KEY); }catch{}
 return !!next&&next.n>=ACCESS_ERR_LIMIT;
}
// Text safe to show inline for any error.
function accessText(x:any,fallback:string):string{
 const code=firebaseAccessCode(x);
 if(!code){noteAccessError(null);return x?.message||fallback;}
 _lastAccessCode=code;
 return noteAccessError(code)?ACCESS_PERSIST:ACCESS_GENERIC;
}
// Toast + inline text in one call: setErr(fail(toast,x,"Unable to save profile"))
function fail(toast:ReturnType<typeof useToast>,x:any,fallback:string):string{
 const text=accessText(x,fallback);
 if(text===ACCESS_PERSIST)toast("error","Still not working.",{label:"Contact support",href:supportUrl(`Hi, something keeps going wrong on my account${_lastAccessCode?` (${_lastAccessCode})`:""}. Can you help?`)});
 else toast("error",text);
 return text;
}
// Render inline error text; the persistent case gets a Contact support link.
function ErrText({text}:{text:string}){
 if(text!==ACCESS_PERSIST)return <>{text}</>;
 return <>Still not working. <a className="spts-link" href={supportUrl(`Hi, something keeps going wrong on my account${_lastAccessCode?` (${_lastAccessCode})`:""}. Can you help?`)} target="_blank" rel="noreferrer">Contact support</a> for help.</>;
}

const flaggedError=()=>Object.assign(new Error("account-flagged"),{code:"spts/account-flagged"});
const isFlagged=(x:any)=>x?.code==="spts/account-flagged";
type Standing={state:"new"}|{state:"ok";username:string;profile:any};
// users/{uid} -> username -> profiles/{username}, whose uid must equal the signed-in uid.
// No users/{uid} at all = a new sign-up that hasn't created a profile yet (normal, not flagged).
async function checkAccount(user:User):Promise<Standing>{
 const us=await getDoc(doc(profileDb,"users",user.uid));
 if(!us.exists())return {state:"new"};
 const uname:string=us.data().username;
 const pf=uname?await getDoc(doc(profileDb,"profiles",uname)):null;
 if(!pf||!pf.exists()||pf.data().uid!==user.uid)throw flaggedError();
 return {state:"ok",username:uname,profile:pf.data()};
}
async function requireLinkedProfile(user:User):Promise<string>{
 const st=await checkAccount(user);
 if(st.state==="new")throw new Error("Create your public profile first, then upgrade.");
 return st.username;
}

// Edit these two lists to match what really is / isn't affected.
const FLAG_AFFECTED=["Editing or managing your profile","Posts, and messaging through public profile","Premium upgrade and some features"];
const FLAG_STILL_OK=["Logging in and out","Viewing other people's public profiles","Sending messages and comments on other profiles","Your public profile and portfolio"];
function AccountFlagNotice({uid,showSupport=true}:{uid?:string;showSupport?:boolean}){
 return <div className="spts-flag-notice" role="alert">
  <p>Your account is currently restricted, so some features may not work until it has been reviewed.</p>
  <div><span className="spts-flag-h">May not work</span><ul>{FLAG_AFFECTED.map(t=><li key={t}>{t}</li>)}</ul></div>
  <div><span className="spts-flag-h spts-flag-ok">Still available</span><ul>{FLAG_STILL_OK.map(t=><li key={t}>{t}</li>)}</ul></div>
  <p>Your login and the services above are not affected.{showSupport&&<> If you think this is a mistake, <a className="spts-link" href={supportUrl(`Hi, my account is showing as restricted and I'd like it reviewed.${uid?` Account ID: ${uid}`:""}`)} target="_blank" rel="noreferrer">contact support</a> and we'll review it.</>}</p>
 </div>;
}

/* ------------------------------------------------------------------ *
 * Shared UI primitives: Toasts, ConfirmDialog, SpinnerButton
 * These replace window.confirm / window.alert everywhere and give
 * every async action a visible loading state.
 * ------------------------------------------------------------------ */

/* Icons: small inline SVGs (currentColor), so the app has no emoji or font-dependent symbols. */
function Ico({d,filled}:{d:string;filled?:boolean}){
 return <svg className="spts-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={d} fill={filled?"currentColor":"none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
const ICON={
 heart:"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
 play:"M7 4.5v15l12-7.5z",
 expand:"M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
 close:"M18 6L6 18M6 6l12 12",
 send:"M22 2L11 13M22 2l-7 20-4-9-9-4z",
 check:"M20 6L9 17l-5-5",
 back:"M19 12H5M12 19l-7-7 7-7",
 next:"M5 12h14M12 5l7 7-7 7",
};

type Toast = { id: number; kind: "success"|"error"|"info"; text: string; action?: {label:string;href:string}; key?: string };
type PushToast = (kind: Toast["kind"], text: string, action?: Toast["action"], key?: string)=>void;
const ToastCtx = React.createContext<PushToast>(()=>{});
function useToast(){ return React.useContext(ToastCtx); }

function ToastHost({children}:{children?:React.ReactNode}){
 const [items,setItems]=useState<Toast[]>([]);
 const idRef=useRef(0);
 // A toast with a key never stacks on itself, and a new hint (key "hint:…") replaces the previous hint.
 const push=React.useCallback<PushToast>((kind,text,action,key)=>{
  const id=++idRef.current;
  setItems(s=>{
   if(key&&s.some(t=>t.key===key))return s;
   const keep=key?.startsWith("hint:")?s.filter(t=>!t.key?.startsWith("hint:")):s;
   return [...keep,{id,kind,text,action,key}];
  });
  setTimeout(()=>setItems(s=>s.filter(t=>t.id!==id)),action?9000:key?5500:4200); // links and hints stay longer
 },[]);
 return <ToastCtx.Provider value={push}>
  {children}
  <div className="spts-toast-host" role="status" aria-live="polite">
   {items.map(t=><div key={t.id} className={`spts-toast spts-toast-${t.kind}`} onClick={()=>setItems(s=>s.filter(x=>x.id!==t.id))}>
    <span className="spts-toast-icon">{t.kind==="success"?<Ico d={ICON.check}/>:t.kind==="error"?"!":"i"}</span>
    <span>{t.text}{t.action&&<> <a className="spts-toast-action" href={t.action.href} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>{t.action.label}</a></>}</span>
   </div>)}
  </div>
 </ToastCtx.Provider>;
}

/* ------------------------------------------------------------------ *
 * Hints: tap or hover an ambiguous word, or hover a contact button, and a toast says what it means.
 * Words and badges answer to tap and hover. Buttons and links answer to mouse hover and keyboard
 * focus only, because tapping them already does something.
 * ------------------------------------------------------------------ */
const HINTS={
 anonymous:"Anonymous: your name and email are never shown. The owner only sees a random visitor ID tied to this device.",
 autodelete:"Auto delete: this is removed 24 hours after it's created. It runs from the device that created it, so that device needs to be online with its data uncleared.",
 visitor:"Visitor: an anonymous ID for one device. Deleting a visitor removes all their messages and replies.",
 deleteVisitor:"Removes this visitor with all their messages and replies.",
 msgLimit:`Messages can be ${MSG_MIN} to ${MSG_MAX} characters.`,
 commentLimit:`Comments can be ${COMMENT_MIN} to ${COMMENT_MAX} characters.`,
 seePosts:"Shows this profile's posts. The other buttons hide until you hide them.",
 message:"Send the owner an anonymous message. Only they can reply.",
 portfolio:"Opens this owner's portfolio page.",
 share:"Copies this profile's link.",
 getOwn:"Create your own public profile.",
 website:"Opens the owner's website in a new tab.",
 email:"Opens your email app to write to the owner.",
 phone:"Calls the owner if your device supports calling.",
 contactNote:"Links, emails and phone numbers in the bio are made tappable.",
 premium:"Premium: gold profile theme, direct file uploads, and your own portfolio page that you upload yourself.",
 live:"Your public profile is live and visible to anyone with your link.",
 like:"Likes are removed 24 hours after they're added, from the device that added them.",
 postCount:`Posts used out of the ${MAX_POSTS} allowed.`,
 inboxCount:"Conversations with visitors. Each visitor is one conversation.",
 upgrade:"Opens Paystack to pay for Premium, which unlocks the gold theme, file uploads and uploading your own portfolio.",
 adLive:"Your portfolio page is visible to the public.",
 adScheduled:"Your portfolio is ready and goes live on its start date.",
 adWaiting:"Request received. We're preparing your portfolio.",
 adExpired:"This run has ended. You can request another.",
} as const;
type HintKey=keyof typeof HINTS;

function useHint(){
 const toast=useToast();
 const timer=useRef<number|undefined>(undefined);
 useEffect(()=>()=>window.clearTimeout(timer.current),[]);
 const show=React.useCallback((k:HintKey)=>toast("info",HINTS[k],undefined,`hint:${k}`),[toast]);
 // props(k): mouse hover + keyboard focus. props(k,true): also tap.
 const props=React.useCallback((k:HintKey,tap=false)=>{
  const p:Record<string,any>={
   onPointerEnter:(e:React.PointerEvent)=>{ if(e.pointerType!=="mouse")return; window.clearTimeout(timer.current); timer.current=window.setTimeout(()=>show(k),350); },
   onPointerLeave:()=>window.clearTimeout(timer.current),
   onFocus:(e:React.FocusEvent<HTMLElement>)=>{ try{ if(e.currentTarget.matches(":focus-visible"))show(k); }catch{} },
  };
  if(tap)p.onClick=()=>show(k);
  return p;
 },[show]);
 return {props,show};
}
function Hint({k,children,className,plain}:{k:HintKey;children:React.ReactNode;className?:string;plain?:boolean}){
 const {props,show}=useHint();
 return <span role="button" tabIndex={0} className={`spts-hint${plain?"":" spts-hint-word"}${className?" "+className:""}`} {...props(k,true)}
  onKeyDown={e=>{ if(e.key==="Enter"||e.key===" "){e.preventDefault();show(k);} }}>{children}</span>;
}

// Minimal context so any descendant can open a dialog without prop drilling.
type ConfirmOpts = {
 title: string;
 body: React.ReactNode;
 confirmLabel?: string;
 cancelLabel?: string;
 danger?: boolean;
 requireText?: string;
 requireTextHint?: string;
};
type ConfirmHandle = (opts: ConfirmOpts)=>Promise<boolean>;
const ConfirmCtx = React.createContext<ConfirmHandle>(async()=>false);
function useConfirm(){ return React.useContext(ConfirmCtx); }

function ConfirmHost({children}:{children?:React.ReactNode}){
 const [opts,setOpts]=useState<ConfirmOpts|null>(null);
 const [typed,setTyped]=useState("");
 const resolverRef=useRef<((v:boolean)=>void)|null>(null);

 function open(o:ConfirmOpts){
  setOpts(o);setTyped("");
  return new Promise<boolean>(res=>{ resolverRef.current=res; });
 }
 function close(v:boolean){
  resolverRef.current?.(v);
  resolverRef.current=null;
  setOpts(null);setTyped("");
 }
 const canConfirm = opts ? (!opts.requireText || typed.trim()===opts.requireText) : false;

 return <ConfirmCtx.Provider value={open}>
  {children}
  {opts&&<div className="spts-modal-backdrop" role="dialog" aria-modal="true" onClick={()=>close(false)}>
   <div className="spts-modal" onClick={e=>e.stopPropagation()}>
    <h3 className="spts-modal-title">{opts.title}</h3>
    <div className="spts-modal-body">{opts.body}</div>
    {opts.requireText&&<label className="spts-modal-typed">
     <span className="spts-muted">{opts.requireTextHint ?? `Type "${opts.requireText}" to confirm`}</span>
     <input autoFocus value={typed} onChange={e=>setTyped(e.target.value)} placeholder={opts.requireText}/>
    </label>}
    <div className="spts-modal-actions">
     <button type="button" className="spts-ghost" onClick={()=>close(false)}>{opts.cancelLabel??"Cancel"}</button>
     <button type="button"
      className={opts.danger?"spts-danger":""}
      disabled={!canConfirm}
      onClick={()=>close(true)}>
      {opts.confirmLabel??"Confirm"}
     </button>
    </div>
   </div>
  </div>}
 </ConfirmCtx.Provider>;
}

// A button that shows a spinner while an async action is in flight and
// disables itself so it can't be double-clicked.
function SpinnerButton({
 children,busy,busyLabel,className,type="button",disabled,onClick,title,extra,
}:{
 children:React.ReactNode;busy:boolean;busyLabel?:string;className?:string;
 type?:"button"|"submit";disabled?:boolean;onClick?:()=>void;title?:string;extra?:Record<string,any>;
}){
 return <button type={type} className={className} disabled={disabled||busy} onClick={onClick} title={title} {...extra}>
  {busy&&<span className="spts-spinner" aria-hidden="true"/>}
  {busy?(busyLabel??"Working…"):children}
 </button>;
}

/* ------------------------------------------------------------------ *
 * ActiveVideo context — makes sure only one post video plays at a
 * time. Opening a new video tells every other PostMedia to fall back
 * to its paused thumbnail frame.
 * ------------------------------------------------------------------ */
const ActiveVideoCtx=React.createContext<[string|null,(id:string|null)=>void]>([null,()=>{}]);
function ActiveVideoHost({children}:{children?:React.ReactNode}){
 const [activeId,setActiveId]=useState<string|null>(null);
 return <ActiveVideoCtx.Provider value={[activeId,setActiveId]}>{children}</ActiveVideoCtx.Provider>;
}

/* ------------------------------------------------------------------ *
 * PostMedia — portrait-first (9:16) immersive media viewer.
 * - Starts at a 9:16 frame, then relaxes toward the media's own
 *   aspect ratio (clamped between 9:16 and 16:9) once it's known, so
 *   landscape/square media adapt automatically without distortion.
 * - Videos never autoplay: only a browser-generated thumbnail frame
 *   is shown (preload="metadata") until the user taps play, and only
 *   one video across the page plays at a time (ActiveVideoCtx).
 * - Images load normally; both media types get an expand control for
 *   a distortion-free full-screen view (object-fit: contain).
 * ------------------------------------------------------------------ */
function clampMediaRatio(w:number,h:number):number{
 if(!w||!h)return 9/16;
 const r=w/h;
 return Math.min(16/9,Math.max(9/16,r));
}
function PostMedia({post}:{post:any}){
 const isVideo=post.mediaType==="video";
 const [activeId,setActiveId]=React.useContext(ActiveVideoCtx);
 const [opened,setOpened]=useState(false);
 const [ratio,setRatio]=useState<number|null>(null);
 const [orientation,setOrientation]=useState<"portrait"|"landscape"|"square">("portrait");
 const [fullscreen,setFullscreen]=useState(false);
 const videoRef=useRef<HTMLVideoElement>(null);

 useEffect(()=>{
  if(isVideo&&opened&&activeId!==post.id){
   videoRef.current?.pause();
   setOpened(false);
  }
 },[activeId,isVideo,opened,post.id]);

 function applyDims(w:number,h:number){
  setRatio(clampMediaRatio(w,h));
  setOrientation(w>h?"landscape":w<h?"portrait":"square");
 }

 function openVideo(){
  setActiveId(post.id);
  setOpened(true);
  requestAnimationFrame(()=>{videoRef.current?.play().catch(()=>{});});
 }
 function onVideoEnded(){
  setOpened(false);
  setActiveId(null);
 }

 const frameStyle:React.CSSProperties={aspectRatio:ratio?String(ratio):"9 / 16"};

 return <div className={`spts-media-frame spts-media-${orientation}`} style={frameStyle}>
  {isVideo?<>
   <video
    ref={videoRef}
    className="spts-media-el"
    src={post.mediaUrl}
    preload={opened?"auto":"metadata"}
    muted={!opened}
    playsInline
    controls={opened}
    onLoadedMetadata={e=>applyDims(e.currentTarget.videoWidth,e.currentTarget.videoHeight)}
    onEnded={onVideoEnded}
    onClick={opened?undefined:openVideo}
   />
   {!opened&&<button type="button" className="spts-media-play" onClick={openVideo} aria-label="Play video">
    <span className="spts-media-play-icon" aria-hidden="true"><Ico d={ICON.play} filled/></span>
   </button>}
  </>:
   <img
    className="spts-media-el"
    src={post.mediaUrl}
    alt={post.caption||""}
    loading="lazy"
    onLoad={e=>applyDims(e.currentTarget.naturalWidth,e.currentTarget.naturalHeight)}
    onClick={()=>setFullscreen(true)}
   />
  }
  <button type="button" className="spts-media-expand" onClick={()=>setFullscreen(true)} aria-label="View full screen" title="View full screen"><Ico d={ICON.expand}/></button>
  {fullscreen&&<MediaLightbox post={post} isVideo={isVideo} onClose={()=>setFullscreen(false)}/>}
 </div>;
}

/* ------------------------------------------------------------------ *
 * MediaLightbox — distortion-free full-screen viewing (object-fit:
 * contain regardless of orientation), closable via backdrop, close button or Esc.
 * ------------------------------------------------------------------ */
function MediaLightbox({post,isVideo,onClose,autoCloseMs}:{post:any;isVideo:boolean;onClose:()=>void;autoCloseMs?:number}){
 useEffect(()=>{
  function onKey(e:KeyboardEvent){ if(e.key==="Escape")onClose(); }
  document.addEventListener("keydown",onKey);
  return ()=>document.removeEventListener("keydown",onKey);
 },[onClose]);
 // Optional silent auto-close (nothing is shown to the user). The latest onClose is read from a ref so
 // a parent re-render never restarts the timer.
 const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{
  if(!autoCloseMs)return;
  const t=window.setTimeout(()=>closeRef.current(),autoCloseMs);
  return ()=>window.clearTimeout(t);
 },[autoCloseMs]);
 return <div className="spts-lightbox-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
  <button type="button" className="spts-lightbox-close" onClick={onClose} aria-label="Close full screen view"><Ico d={ICON.close}/></button>
  <div className="spts-lightbox-stage" onClick={e=>e.stopPropagation()}>
   {isVideo
    ?<video className="spts-lightbox-media" src={post.mediaUrl} controls autoPlay playsInline/>
    :<img className="spts-lightbox-media" src={post.mediaUrl} alt={post.caption||""}/>}
  </div>
 </div>;
}

/* ------------------------------------------------------------------ *
 * LinkText — unchanged
 * ------------------------------------------------------------------ */
const LinkText=({text}:{text:string})=><>{text.split(/(https?:\/\/[^\s]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d\s().-]{7,}\d)/gi).map((x,i)=>{
 if(/^https?:\/\//i.test(x))return <a key={i} href={x} target="_blank" rel="noreferrer">{x}</a>;
 if(/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(x))return <a key={i} href={`mailto:${x}`}>{x}</a>;
 if(/^\+?\d[\d\s().-]{7,}\d$/.test(x))return <a key={i} href={`tel:${x.replace(/[^\d+]/g,"")}`}>{x}</a>;
 return <React.Fragment key={i}>{x}</React.Fragment>;
})}</>;

/* ------------------------------------------------------------------ *
 * ClampText: long text shows its first CLAMP_CHARS characters, then "See more" / "See less".
 * It backs up to a word boundary so a link or number is never cut in half.
 * ------------------------------------------------------------------ */
function clampAt(t:string,max:number):number{
 if(t.length<=max)return t.length;
 if(!/\s/.test(t[max])&&!/\s/.test(t[max-1])){
  const start=t.slice(0,max).search(/\S+$/);
  if(start>=max-150&&start>0)return start;
 }
 return max;
}
function ClampText({text,plain}:{text:string;plain?:boolean}){
 const [open,setOpen]=useState(false);
 const long=text.length>CLAMP_CHARS;
 const body=long&&!open?text.slice(0,clampAt(text,CLAMP_CHARS)).trimEnd():text;
 return <>
  {plain?body:<LinkText text={body}/>}
  {long&&<>{!open&&"… "}<button type="button" className="spts-clamp-btn" aria-expanded={open} onClick={()=>setOpen(o=>!o)}>{open?"See less":"See more"}</button></>}
 </>;
}

// A textarea that grows with its text (up to maxH px), then scrolls.
function AutoTextarea({maxH=140,...p}:React.TextareaHTMLAttributes<HTMLTextAreaElement>&{maxH?:number}){
 const ref=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{
  const el=ref.current;if(!el)return;
  el.style.height="auto";
  el.style.height=Math.min(el.scrollHeight,maxH)+"px";
 },[p.value,maxH]);
 return <textarea ref={ref} rows={1} {...p}/>;
}

/* ------------------------------------------------------------------ *
 * Auto-delete warnings — shown wherever content is created, so
 * everyone understands the 24h deletion depends on this device.
 * ------------------------------------------------------------------ */
const TTL_DEVICE_CAVEAT="It runs when you're online.";
function AutoDeleteNotice({text}:{text:string}){
 return <p className="spts-ttl-notice"><Hint k="autodelete">Auto delete</Hint><span>{text} {TTL_DEVICE_CAVEAT}</span></p>;
}
function AutoDeleteNoticeSm({text}:{text:string}){
 return <small className="spts-ttl-notice-sm"><Hint k="autodelete">Auto delete</Hint> {text} Different device or cleared data stops it.</small>;
}

/* ------------------------------------------------------------------ *
 * Cascades — unchanged, just relocated
 * ------------------------------------------------------------------ */
// Deletes in chunks of 400 (batch limit is 500). Order matters: put the parent last.
async function commitDeletes(refs:any[]){
 for(let i=0;i<refs.length;i+=400){
  const b=writeBatch(profileDb);
  refs.slice(i,i+400).forEach(r=>b.delete(r));
  await b.commit();
 }
}
async function cascadePost(postId:string){
 const [l,c]=await Promise.all([
  getDocs(query(collection(profileDb,"posts",postId,"likes"),limit(500))),
  getDocs(query(collection(profileDb,"posts",postId,"comments"),limit(500)))
 ]);
 const refs:any[]=[];
 l.forEach(x=>refs.push(x.ref));
 await Promise.all(c.docs.map(async cd=>{
  const cl=await getDocs(query(collection(cd.ref,"likes"),limit(500)));
  cl.forEach(x=>refs.push(x.ref));
  refs.push(cd.ref);
 }));
 refs.push(doc(profileDb,"posts",postId));
 await commitDeletes(refs);
}
// A comment goes together with its likes.
async function cascadeComment(postId:string,commentId:string){
 const cref=doc(profileDb,"posts",postId,"comments",commentId);
 const l=await getDocs(query(collection(cref,"likes"),limit(500)));
 await commitDeletes([...l.docs.map(x=>x.ref),cref]);
}
async function cascadeMessage(conversationId:string,messageId:string){
 const b=writeBatch(profileDb);
 b.delete(doc(profileDb,"conversations",conversationId,"messages",messageId));
 const r=await getDocs(query(
  collection(profileDb,"conversations",conversationId,"messages",messageId,"replies"),
  limit(500)
 ));
 r.forEach(x=>b.delete(x.ref)); await b.commit();
}

// Deletes a visitor entirely: every message, every reply, then the conversation
// itself (last, so a failure part-way leaves it visible to retry).
async function cascadeConversation(conversationId:string){
 const refs:any[]=[];
 const ms=await getDocs(query(collection(profileDb,"conversations",conversationId,"messages"),limit(500)));
 await Promise.all(ms.docs.map(async m=>{
  const r=await getDocs(query(collection(m.ref,"replies"),limit(500)));
  r.forEach(x=>refs.push(x.ref));
  refs.push(m.ref);
 }));
 refs.push(doc(profileDb,"conversations",conversationId));
 for(let i=0;i<refs.length;i+=400){
  const b=writeBatch(profileDb);
  refs.slice(i,i+400).forEach(r=>b.delete(r));
  await b.commit();
 }
}

/* ------------------------------------------------------------------ *
 * 24h auto-delete queue (device-local, no backend TTL)
 * When something is created, an entry with a delete-at time is saved
 * to localStorage. Whenever the app loads (or every few minutes while
 * it's open) on that same browser/device, due entries are removed
 * from the queue and deleted with the exact same calls the manual
 * delete buttons use (cascadePost/cascadeMessage/deleteDoc) — so an
 * automatic delete looks identical to the user having clicked delete
 * themselves. If this device never comes back, the queue entry (and
 * the data) just stays put — no server-side component.
 * ------------------------------------------------------------------ */
const TTL_STORAGE_KEY="spts_ttl_queue";
const TTL_MS=24*60*60*1000;
type TTLBase=
 |{kind:"post";postId:string;deleteAt:number}
 |{kind:"comment";postId:string;commentId:string;deleteAt:number}
 |{kind:"like";postId:string;uid:string;deleteAt:number}
 |{kind:"commentlike";postId:string;commentId:string;uid:string;deleteAt:number}
 |{kind:"conversation";conversationId:string;deleteAt:number}
 |{kind:"message";conversationId:string;messageId:string;deleteAt:number}
 |{kind:"reply";conversationId:string;messageId:string;replyId:string;deleteAt:number};
type TTLEntry=TTLBase&{tries?:number};

function readTTLQueue():TTLEntry[]{
 try{ return JSON.parse(localStorage.getItem(TTL_STORAGE_KEY)||"[]"); }catch{ return []; }
}
function writeTTLQueue(q:TTLEntry[]){
 try{ localStorage.setItem(TTL_STORAGE_KEY,JSON.stringify(q)); }catch{}
}
function scheduleAutoDelete(entry:TTLEntry|Omit<TTLEntry,"deleteAt">){
 const withTime="deleteAt" in entry?entry as TTLEntry:{...entry,deleteAt:Date.now()+TTL_MS} as TTLEntry;
 writeTTLQueue([...readTTLQueue(),withTime]);
}
// Posts, comments and likes can only be deleted by their signed-in owner; conversations, messages and replies
// need no sign-in. An item leaves the queue only once its delete has worked. It waits while the person is signed
// out, is retried on later sweeps if the delete fails, and is dropped after TTL_MAX_TRIES failures or a week overdue.
const TTL_NEEDS_AUTH=new Set(["post","comment","like","commentlike"]);
const TTL_MAX_TRIES=5,TTL_GIVE_UP_MS=7*24*60*60*1000;
const ttlId=(e:TTLEntry)=>{ const {tries,...rest}=e as any; return JSON.stringify(rest); };
let ttlSweeping=false;
async function runTTLSweep(){
 if(ttlSweeping)return;
 const now=Date.now();
 const due=readTTLQueue().filter(e=>e.deleteAt<=now);
 if(due.length===0)return;
 ttlSweeping=true;
 try{
  const signedIn=!!profileAuth.currentUser;
  const done=new Set<string>(),failed=new Set<string>();
  for(const e of due){
   const id=ttlId(e);
   if(now-e.deleteAt>TTL_GIVE_UP_MS){done.add(id);continue;}          // too old to keep trying
   if(!signedIn&&TTL_NEEDS_AUTH.has(e.kind))continue;                 // wait for sign-in
   try{
    if(e.kind==="post")await cascadePost(e.postId);
    else if(e.kind==="comment")await cascadeComment(e.postId,e.commentId);
    else if(e.kind==="commentlike")await deleteDoc(doc(profileDb,"posts",e.postId,"comments",e.commentId,"likes",e.uid));
    else if(e.kind==="like")await deleteDoc(doc(profileDb,"posts",e.postId,"likes",e.uid));
    else if(e.kind==="conversation")await deleteDoc(doc(profileDb,"conversations",e.conversationId));
    else if(e.kind==="message")await cascadeMessage(e.conversationId,e.messageId);
    else if(e.kind==="reply")await deleteDoc(doc(profileDb,"conversations",e.conversationId,"messages",e.messageId,"replies",e.replyId));
    done.add(id);
   }catch{ failed.add(id); }                                           // keep it and try again next sweep
  }
  // Re-read the queue so anything added while sweeping is kept.
  writeTTLQueue(readTTLQueue()
   .filter(e=>!done.has(ttlId(e)))
   .map(e=>failed.has(ttlId(e))?{...e,tries:(e.tries||0)+1}:e)
   .filter(e=>(e.tries||0)<TTL_MAX_TRIES));
 }finally{ ttlSweeping=false; }
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
function Auth({done}:{done:()=>void}){
 const [signup,setSignup]=useState(true),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[err,setErr]=useState(""),[busy,setBusy]=useState(false);
 const [resetting,setResetting]=useState(false);
 const toast=useToast();
 // Firebase emails a reset link. The message is the same whether or not the address has an account.
 async function reset(){
  setErr("");
  const to=email.trim();
  if(!to){setErr("Enter your email above, then tap Reset password.");return;}
  if(!/^\S+@\S+\.\S+$/.test(to)){setErr("Enter a valid email address.");return;}
  setResetting(true);
  const sent=()=>toast("success",`If an account exists for ${to}, a reset link is on its way. Check spam too.`);
  try{ await sendPasswordResetEmail(profileAuth,to);sent(); }
  catch(x:any){ if(x?.code==="auth/user-not-found")sent(); else setErr(fail(toast,x,"Unable to send reset link")); }
  finally{ setResetting(false); }
 }
 async function go(e:React.FormEvent){e.preventDefault();setErr("");setBusy(true);try{
  if(signup)await createUserWithEmailAndPassword(profileAuth,email,password);
  else await signInWithEmailAndPassword(profileAuth,email,password);
  toast("success",signup?"Account created.":"Welcome back.");
  done();
 }catch(x:any){setErr(fail(toast,x,"Authentication failed"));}
 finally{setBusy(false);}}
 return <section className="spts-card"><h2>{signup?"Create your profile":"Log in"}</h2><form onSubmit={go}>
 <label>Email<input type="email" required placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></label>
 <label>Password<input type="password" required minLength={6} placeholder="At least 6 characters" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
 <SpinnerButton type="submit" busy={busy} busyLabel={signup?"Creating…":"Logging in…"}>{signup?"Sign up":"Log in"}</SpinnerButton>
 </form>{err&&<p className="spts-error"><ErrText text={err}/></p>}
 {!signup&&<p><button type="button" className="spts-link" onClick={reset} disabled={busy||resetting}>{resetting?"Sending link…":"Reset password"}</button></p>}
 <button className="spts-link" onClick={()=>setSignup(!signup)} disabled={busy||resetting}>{signup?"Already registered? Log in":"Create an account"}</button></section>
}

/* ------------------------------------------------------------------ *
 * CommentItem — one comment with its own like (posts/{id}/comments/{id}/likes/{uid})
 * ------------------------------------------------------------------ */
function CommentItem({postId,comment,user,deleting,onDelete}:{postId:string;comment:any;user:User|null;deleting:boolean;onDelete:()=>void}){
 const [likeCount,setLikeCount]=useState(0),[liked,setLiked]=useState(false),[busy,setBusy]=useState(false);
 const toast=useToast();const hint=useHint();

 useEffect(()=>onSnapshot(collection(profileDb,"posts",postId,"comments",comment.id,"likes"),s=>{
  setLikeCount(s.size);
  setLiked(!!user&&s.docs.some(d=>d.id===user.uid));
 },()=>{}),[postId,comment.id,user?.uid]);

 async function toggleLike(){
  if(!user){toast("error","Log in to like comments.");return;}
  setBusy(true);
  const ref=doc(profileDb,"posts",postId,"comments",comment.id,"likes",user.uid);
  try{
   if(liked)await deleteDoc(ref);
   else{ await setDoc(ref,{createdAt:serverTimestamp()}); scheduleAutoDelete({kind:"commentlike",postId,commentId:comment.id,uid:user.uid}); }
  }catch(x:any){fail(toast,x,"Unable to update like");}
  finally{setBusy(false);}
 }

 return <div className="spts-comment">
  <p><ClampText text={comment.text}/></p>
  <div className="spts-comment-actions">
   <SpinnerButton busy={busy} busyLabel="…" className={liked?"spts-liked":""} onClick={toggleLike} extra={{...hint.props("like"),"aria-label":liked?"Unlike":"Like"}}><Ico d={ICON.heart} filled={liked}/> {likeCount}</SpinnerButton>
   {user&&user.uid===comment.ownerId&&<SpinnerButton className="spts-ghost" busy={deleting} busyLabel="…" onClick={onDelete}>Delete</SpinnerButton>}
  </div>
 </div>;
}

/* ------------------------------------------------------------------ *
 * PostCard
 * ------------------------------------------------------------------ */
function PostCard({post,user,canDeletePost,onDeletePost}:{post:any;user:User|null;canDeletePost:boolean;onDeletePost:()=>Promise<void>}){
 const [likeCount,setLikeCount]=useState(0),[liked,setLiked]=useState(false),[comments,setComments]=useState<any[]>([]),[commentText,setCommentText]=useState(""),[err,setErr]=useState("");
 const [likeBusy,setLikeBusy]=useState(false),[commentBusy,setCommentBusy]=useState(false),[deleteBusy,setDeleteBusy]=useState(false);
 const [pendingDeleteId,setPendingDeleteId]=useState<string|null>(null);
 const [commentsOpen,setCommentsOpen]=useState(false);
 const confirm=useConfirm();const toast=useToast();const hint=useHint();

 useEffect(()=>{
  const unsubLikes=onSnapshot(collection(profileDb,"posts",post.id,"likes"),s=>{
   setLikeCount(s.size);
   setLiked(!!user&&s.docs.some(d=>d.id===user.uid));
  },e=>setErr(accessText(e,ACCESS_GENERIC)));
  return ()=>{unsubLikes()};
 },[post.id,user?.uid]);

 // Comments load only when the visitor opens them.
 useEffect(()=>{
  if(!commentsOpen)return;
  return onSnapshot(query(collection(profileDb,"posts",post.id,"comments"),orderBy("createdAt","asc"),limit(200)),s=>{
   setComments(s.docs.map(d=>({id:d.id,...d.data()} as any)));
  },e=>setErr(accessText(e,ACCESS_GENERIC)));
 },[commentsOpen,post.id]);

 async function toggleLike(){
  if(!user)return setErr("Log in to like posts.");
  setErr("");setLikeBusy(true);
  const ref=doc(profileDb,"posts",post.id,"likes",user.uid);
  try{ liked?await deleteDoc(ref):await setDoc(ref,{createdAt:serverTimestamp()}); if(!liked)scheduleAutoDelete({kind:"like",postId:post.id,uid:user.uid}); }
  catch(x:any){setErr(fail(toast,x,"Unable to update like"));}
  finally{setLikeBusy(false);}
 }

 async function addComment(e:React.FormEvent){
  e.preventDefault();
  if(!user)return setErr("Log in to comment.");
  const text=commentText.trim();
  if(text.length<COMMENT_MIN)return;
  if(text.length>COMMENT_MAX){setErr(`Comments must be ${COMMENT_MIN}-${COMMENT_MAX} characters.`);return;}
  setErr("");setCommentBusy(true);
  try{ const ref=await addDoc(collection(profileDb,"posts",post.id,"comments"),{ownerId:user.uid,text,createdAt:serverTimestamp()}); scheduleAutoDelete({kind:"comment",postId:post.id,commentId:ref.id}); setCommentText(""); toast("success","Comment added — it auto-deletes in 24h on this device."); }
  catch(x:any){setErr(fail(toast,x,"Unable to post comment"));}
  finally{setCommentBusy(false);}
 }

 async function deleteComment(commentId:string){
  const ok=await confirm({
   title:"Delete this comment?",
   body:<p className="spts-muted">This removes your comment and its likes. The post and other comments are not affected.</p>,
   confirmLabel:"Delete comment",danger:true,
  });
  if(!ok)return;
  setPendingDeleteId(commentId);
  try{ await cascadeComment(post.id,commentId);toast("success","Comment deleted."); }
  catch(x:any){setErr(fail(toast,x,"Unable to delete comment"));}
  finally{setPendingDeleteId(null);}
 }

 async function handleDeletePost(){
  const ok=await confirm({
   title:"Delete this post?",
   body:<>
    <p className="spts-muted">This removes the post and its likes and comments. Nothing else is affected — your profile, your other posts, and your inbox are untouched.</p>
   </>,
   confirmLabel:"Delete post",danger:true,
  });
  if(!ok)return;
  setDeleteBusy(true);
  try{ await onDeletePost();toast("success","Post deleted."); }
  finally{setDeleteBusy(false);}
 }

 return <article className="spts-post">
  <PostMedia post={post}/>
  <p><ClampText text={post.caption}/></p>
  <div className="spts-post-actions">
   <SpinnerButton busy={likeBusy} busyLabel="…" className={liked?"spts-liked":""} onClick={toggleLike} extra={{...hint.props("like"),"aria-label":liked?"Unlike":"Like"}}>
    <Ico d={ICON.heart} filled={liked}/> {likeCount}
   </SpinnerButton>
   <button type="button" aria-expanded={commentsOpen} onClick={()=>setCommentsOpen(o=>!o)}>{commentsOpen?"Hide comments":"Comments"}</button>
   {canDeletePost&&<SpinnerButton className="spts-ghost" busy={deleteBusy} busyLabel="Deleting…" onClick={handleDeletePost}>Delete post</SpinnerButton>}
  </div>
  {commentsOpen&&<div className="spts-comments">
   {comments.length===0&&<p className="spts-muted">No comments yet.</p>}
   {comments.map(c=><CommentItem key={c.id} postId={post.id} comment={c} user={user} deleting={pendingDeleteId===c.id} onDelete={()=>deleteComment(c.id)}/>)}
   <form onSubmit={addComment}>
    <AutoTextarea maxH={120} maxLength={COMMENT_MAX} placeholder={user?"Add a comment":"Log in to comment"} value={commentText} onChange={e=>setCommentText(e.target.value)}
     onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit();}}} disabled={!user||commentBusy}/>
    <SpinnerButton type="submit" busy={commentBusy} busyLabel="Posting…" disabled={!user||!commentText.trim()}>Comment</SpinnerButton>
   </form>
   {user&&<div className="spts-field-foot"><Hint k="commentLimit">{COMMENT_MIN}-{COMMENT_MAX} characters</Hint><span>{commentText.length}/{COMMENT_MAX}</span></div>}
   {user&&<AutoDeleteNoticeSm text="Comments are removed after 24h."/>}
  </div>}
  {err&&<p className="spts-error"><ErrText text={err}/></p>}
 </article>;
}

/* ------------------------------------------------------------------ *
 * ReplyThread
 * ------------------------------------------------------------------ */
function ReplyThread({
 conversationId,messageId,viewerRole,canReply,
}:{
 conversationId:string;messageId:string;viewerRole:"owner"|"visitor";canReply:boolean;
}){
 const [replies,setReplies]=useState<any[]>([]);
 const [decrypted,setDecrypted]=useState<Record<string,string>>({});
 const [text,setText]=useState("");
 const [err,setErr]=useState("");
 const [sending,setSending]=useState(false);
 const [pendingDeleteId,setPendingDeleteId]=useState<string|null>(null);
 const confirm=useConfirm();const toast=useToast();

 useEffect(()=>{
  const q=query(
   collection(profileDb,"conversations",conversationId,"messages",messageId,"replies"),
   orderBy("createdAt","asc"),
   limit(MAX_REPLIES_PER_MESSAGE)
  );
  return onSnapshot(q,async s=>{
   const docs:any[]=s.docs.map(d=>({id:d.id,...d.data()}));
   setReplies(docs);
   const out:Record<string,string>={};
   await Promise.all(docs.map(async r=>{
    try{ out[r.id]=await decryptMessage(r.ciphertext,r.time,r.deviceId,r.iv); }
    catch{ out[r.id]="[unable to decrypt]"; }
   }));
   setDecrypted(out);
  },e=>setErr(accessText(e,ACCESS_GENERIC)));
 },[conversationId,messageId]);

 async function sendReply(e:React.FormEvent){
  e.preventDefault();
  if(!canReply)return;
  const t=text.trim();
  if(t.length<MSG_MIN||t.length>MSG_MAX){setErr(`Reply must be ${MSG_MIN}-${MSG_MAX} characters.`);return;}
  if(replies.length>=MAX_REPLIES_PER_MESSAGE){setErr("Reply limit reached for this message.");return;}
  setSending(true);setErr("");
  try{
   const e2=await encryptMessage(t);
   const replyRef=await addDoc(
    collection(profileDb,"conversations",conversationId,"messages",messageId,"replies"),
    {
     senderId:viewerRole==="owner"?"owner":e2.deviceId,
     role:viewerRole,
     ciphertext:e2.ciphertext,time:e2.time,deviceId:e2.deviceId,iv:e2.iv,
     createdAt:serverTimestamp(),
    }
   );
   scheduleAutoDelete({kind:"reply",conversationId,messageId,replyId:replyRef.id});
   setText("");toast("success","Reply sent — it auto-deletes in 24h on this device.");
  }catch(x:any){ setErr(fail(toast,x,"Unable to send reply")); }
  finally{ setSending(false); }
 }

 async function deleteReply(replyId:string){
  const ok=await confirm({
   title:"Delete this reply?",
   body:<p className="spts-muted">This removes only this reply. The parent message, other replies, and the rest of the conversation are not affected.</p>,
   confirmLabel:"Delete reply",danger:true,
  });
  if(!ok)return;
  setPendingDeleteId(replyId);
  try{
   await deleteDoc(doc(profileDb,"conversations",conversationId,"messages",messageId,"replies",replyId));
   toast("success","Reply deleted.");
  }catch(x:any){ setErr(fail(toast,x,"Unable to delete reply")); }
  finally{ setPendingDeleteId(null); }
 }

 return <div className="spts-replies">
  {replies.length===0&&<p className="spts-muted">No replies.</p>}
  {replies.map(r=><div className={`spts-reply spts-reply-${r.role}`} key={r.id}>
   <span className="spts-reply-role">{r.role==="owner"?"Owner":"Visitor"}</span>
   <p><ClampText text={decrypted[r.id]??"…"}/></p>
   <SpinnerButton className="spts-ghost" busy={pendingDeleteId===r.id} busyLabel="Deleting…" onClick={()=>deleteReply(r.id)}>Delete</SpinnerButton>
  </div>)}
  {canReply&&<form className="spts-reply-form" onSubmit={sendReply}>
   <AutoTextarea
    maxH={120}
    maxLength={MSG_MAX}
    placeholder="Reply…"
    value={text}
    onChange={e=>setText(e.target.value)}
    onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}
    disabled={sending}
   />
   <SpinnerButton type="submit" busy={sending} busyLabel="Sending…" disabled={!text.trim()}>Reply</SpinnerButton>
  </form>}
  {canReply&&<AutoDeleteNoticeSm text="Replies are removed after 24h."/>}
  {err&&<p className="spts-error"><ErrText text={err}/></p>}
 </div>;
}

/* ------------------------------------------------------------------ *
 * ConversationThread
 * ------------------------------------------------------------------ */
function ConversationThread({conversationId,visitorId,viewerRole="owner",previewCount}:{conversationId:string;visitorId:string;viewerRole?:"owner"|"visitor";previewCount?:number}){
 const [messages,setMessages]=useState<any[]>([]),[decrypted,setDecrypted]=useState<Record<string,string>>({}),[loading,setLoading]=useState(true),[err,setErr]=useState("");
 const [openReplies,setOpenReplies]=useState<Record<string,boolean>>({});
 const [pendingDeleteId,setPendingDeleteId]=useState<string|null>(null);
 const [showAllMessages,setShowAllMessages]=useState(!previewCount);
 const [deletingVisitor,setDeletingVisitor]=useState(false);
 const confirm=useConfirm();const toast=useToast();const hint=useHint();

 useEffect(()=>{
  const q=query(collection(profileDb,"conversations",conversationId,"messages"),orderBy("createdAt","asc"),limit(MAX_MESSAGES*2));
  return onSnapshot(q,async s=>{
   const docs:any[]=s.docs.map(d=>({id:d.id,...d.data()}));
setMessages(docs);setLoading(false);
   const out:Record<string,string>={};
   await Promise.all(docs.map(async m=>{
    try{ out[m.id]=await decryptMessage(m.ciphertext,m.time,m.deviceId,m.iv); }
    catch{ out[m.id]="[unable to decrypt]"; }
   }));
   setDecrypted(out);
  },e=>{setErr(accessText(e,ACCESS_GENERIC));setLoading(false)});
 },[conversationId]);

 async function deleteMessage(messageId:string){
  const ok=await confirm({
   title:"Delete this message?",
   body:<p className="spts-muted">This removes the message and its replies. Other messages and replies in this conversation are not affected.</p>,
   confirmLabel:"Delete message",danger:true,
  });
  if(!ok)return;
  setPendingDeleteId(messageId);
  try{ await cascadeMessage(conversationId,messageId);toast("success","Message deleted."); }
  catch(x:any){setErr(fail(toast,x,"Unable to delete message"));}
  finally{setPendingDeleteId(null);}
 }

 async function deleteVisitor(){
  const ok=await confirm({
   title:"Delete this visitor?",
   body:<p className="spts-muted">Removes the visitor with all their messages and replies. This can't be undone.</p>,
   confirmLabel:"Delete visitor",danger:true,
  });
  if(!ok)return;
  setDeletingVisitor(true);
  try{ await cascadeConversation(conversationId);toast("success","Visitor deleted."); }
  catch(x:any){setErr(fail(toast,x,"Unable to delete visitor"));setDeletingVisitor(false);}
 }

 const shownMessages=(!previewCount||showAllMessages)?messages:messages.slice(Math.max(0,messages.length-previewCount));
 const hiddenCount=messages.length-shownMessages.length;
 return <div className="spts-conversation">
  <div className="spts-conversation-head">
   <span><Hint k="visitor">Visitor</Hint> {visitorId.slice(0,8)}</span>
   {viewerRole==="owner"&&<SpinnerButton className="spts-ghost" busy={deletingVisitor} busyLabel="Deleting…" onClick={deleteVisitor} extra={hint.props("deleteVisitor")}>Delete visitor</SpinnerButton>}
  </div>
  {loading&&<p className="spts-muted">Loading…</p>}
  {err&&<p className="spts-error"><ErrText text={err}/></p>}
  {!loading&&messages.length===0&&<p className="spts-muted">No messages in this conversation.</p>}
  {previewCount&&hiddenCount>0&&<button type="button" className="spts-see-more" onClick={()=>setShowAllMessages(true)}>See {hiddenCount} earlier message{hiddenCount===1?"":"s"}</button>}
  {shownMessages.map(m=><div className="spts-message" key={m.id}>
   <p><ClampText text={decrypted[m.id]??"…"}/></p>
   <div className="spts-message-actions">
    <SpinnerButton className="spts-ghost" busy={pendingDeleteId===m.id} busyLabel="Deleting…" onClick={()=>deleteMessage(m.id)}>Delete</SpinnerButton>
    <button className="spts-ghost" onClick={()=>setOpenReplies(s=>({...s,[m.id]:!s[m.id]}))}>
     {openReplies[m.id]?"Hide replies":"Replies"}
    </button>
   </div>
   {openReplies[m.id]&&<ReplyThread
    conversationId={conversationId}
    messageId={m.id}
    viewerRole={viewerRole}
    canReply={viewerRole==="owner"}
   />}
  </div>)}
  {previewCount&&showAllMessages&&messages.length>previewCount&&<button type="button" className="spts-see-more spts-ghost" onClick={()=>setShowAllMessages(false)}>Show less</button>}
 </div>;
}

/* ------------------------------------------------------------------ *
 * VisitorChat — the public-profile message box, laid out like a chat:
 * message 1 → reply 1 → message 2 → reply 2 …  Visitors only send messages;
 * replies come from the profile owner (from their dashboard inbox).
 * ------------------------------------------------------------------ */
function fmtTime(ts:any){
 try{const d=ts?.toDate?.();return d?d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):"";}catch{return "";}
}

function ChatExchange({conversationId,message,text,deleting,onDelete,onUpdate}:{conversationId:string;message:any;text?:string;deleting:boolean;onDelete:()=>void;onUpdate:()=>void}){
 const [replies,setReplies]=useState<any[]>([]),[dec,setDec]=useState<Record<string,string>>({});

 useEffect(()=>onSnapshot(
  query(collection(profileDb,"conversations",conversationId,"messages",message.id,"replies"),orderBy("createdAt","asc"),limit(MAX_REPLIES_PER_MESSAGE)),
  async s=>{
   const docs:any[]=s.docs.map(d=>({id:d.id,...d.data()}));
   const out:Record<string,string>={};
   await Promise.all(docs.map(async r=>{
    try{ out[r.id]=await decryptMessage(r.ciphertext,r.time,r.deviceId,r.iv); }
    catch{ out[r.id]="[unable to decrypt]"; }
   }));
   setReplies(docs);setDec(out);onUpdate();
  },()=>{}),[conversationId,message.id]);

 return <div className="spts-chat-exchange">
  <div className="spts-chat-row spts-chat-me">
   <div className="spts-chat-bubble"><ClampText text={text??"…"}/></div>
   <div className="spts-chat-meta">
    <span>{fmtTime(message.createdAt)}</span>
    <button type="button" className="spts-chat-del" disabled={deleting} onClick={onDelete}>{deleting?"Deleting…":"Delete"}</button>
   </div>
  </div>
  {replies.map(r=><div key={r.id} className={`spts-chat-row ${r.role==="owner"?"spts-chat-them":"spts-chat-me"}`}>
   <div className="spts-chat-bubble"><ClampText text={dec[r.id]??"…"}/></div>
   <div className="spts-chat-meta"><span>{fmtTime(r.createdAt)}</span></div>
  </div>)}
 </div>;
}

function VisitorChat({conversationId}:{conversationId:string}){
 const [messages,setMessages]=useState<any[]>([]),[dec,setDec]=useState<Record<string,string>>({}),[loading,setLoading]=useState(true),[err,setErr]=useState("");
 const [pendingDeleteId,setPendingDeleteId]=useState<string|null>(null);
 const [tick,setTick]=useState(0);
 const boxRef=useRef<HTMLDivElement>(null);
 const confirm=useConfirm();const toast=useToast();

 useEffect(()=>{
  const q=query(collection(profileDb,"conversations",conversationId,"messages"),orderBy("createdAt","asc"),limit(MAX_MESSAGES*2));
  return onSnapshot(q,async s=>{
   const docs:any[]=s.docs.map(d=>({id:d.id,...d.data()}));
   setMessages(docs);setLoading(false);
   const out:Record<string,string>={};
   await Promise.all(docs.map(async m=>{
    try{ out[m.id]=await decryptMessage(m.ciphertext,m.time,m.deviceId,m.iv); }
    catch{ out[m.id]="[unable to decrypt]"; }
   }));
   setDec(out);
  },e=>{setErr(accessText(e,ACCESS_GENERIC));setLoading(false)});
 },[conversationId]);

 // keep the newest message in view
 useEffect(()=>{const el=boxRef.current;if(el)el.scrollTop=el.scrollHeight;},[messages.length,tick,dec]);

 async function deleteMessage(messageId:string){
  const ok=await confirm({
   title:"Delete this message?",
   body:<p className="spts-muted">This removes the message and its replies.</p>,
   confirmLabel:"Delete message",danger:true,
  });
  if(!ok)return;
  setPendingDeleteId(messageId);
  try{ await cascadeMessage(conversationId,messageId);toast("success","Message deleted."); }
  catch(x:any){setErr(fail(toast,x,"Unable to delete message"));}
  finally{setPendingDeleteId(null);}
 }

 return <div className="spts-chat-thread" ref={boxRef}>
  {loading&&<p className="spts-muted">Loading…</p>}
  {err&&<p className="spts-error"><ErrText text={err}/></p>}
  {!loading&&!err&&messages.length===0&&<p className="spts-muted spts-chat-empty">No messages yet.</p>}
  {messages.map(m=><ChatExchange key={m.id} conversationId={conversationId} message={m} text={dec[m.id]}
   deleting={pendingDeleteId===m.id} onDelete={()=>deleteMessage(m.id)} onUpdate={()=>setTick(t=>t+1)}/>)}
 </div>;
}

/* ------------------------------------------------------------------ *
 * Messages inbox
 * ------------------------------------------------------------------ */
function Messages({user}:{user:User}){
 const [conversations,setConversations]=useState<any[]>([]),[loading,setLoading]=useState(true),[err,setErr]=useState("");
 useEffect(()=>{
  const q=query(collection(profileDb,"conversations"),where("profileOwnerId","==",user.uid));
  return onSnapshot(q,s=>{setConversations(s.docs.map(d=>({id:d.id,...d.data()} as any)));setLoading(false)},e=>{setErr(accessText(e,ACCESS_GENERIC));setLoading(false)});
 },[user.uid]);
 return <section className="spts-card">
  <div className="spts-card-head"><h2>Inbox</h2><Hint k="inboxCount" plain className="spts-badge">{conversations.length}</Hint></div>
  <AutoDeleteNotice text="Messages and replies are removed 24h after they're sent."/>
  {loading&&<p className="spts-muted">Loading messages…</p>}
  {err&&<p className="spts-error">Couldn't load messages: <ErrText text={err}/></p>}
  {!loading&&!err&&conversations.length===0&&<p className="spts-muted">No messages yet. Anyone who visits your public profile can send you one.</p>}
  {conversations.map(c=><ConversationThread key={c.id} conversationId={c.id} visitorId={c.visitorId||c.id}/>)}
 </section>;
}

/* ------------------------------------------------------------------ *
 * Dashboard — profile edit + delete reworked
 * ------------------------------------------------------------------ */
function Dashboard({user}:{user:User}){
 const [profile,setProfile]=useState<any>(null),[posts,setPosts]=useState<any[]>([]),
  [u,setU]=useState(""),[name,setName]=useState(""),[bio,setBio]=useState(""),[photo,setPhoto]=useState(""),[web,setWeb]=useState(""),
  [email,setEmail]=useState(user.email||""),[phone,setPhone]=useState(""),
  [url,setUrl]=useState(""),[caption,setCaption]=useState(""),[file,setFile]=useState<File|null>(null),
  [err,setErr]=useState(""),[editing,setEditing]=useState(true),[loadingProfile,setLoadingProfile]=useState(true);
 const [savingProfile,setSavingProfile]=useState(false);
 const [deletingProfile,setDeletingProfile]=useState(false);
 const [flagged,setFlagged]=useState(false); // signed-in UID not found in its profile: restricted account
 const [addingPost,setAddingPost]=useState(false);
 const [profileOpen,setProfileOpen]=useState(false),[inboxOpen,setInboxOpen]=useState(false);
 const confirm=useConfirm();const toast=useToast();
 const isPremium=!!profile?.premium;
 const locked=!!profile; // after initial setup: bio + any still-empty optional fields are editable
 const fieldLocked=(v:any)=>locked&&!!String(v??"").trim(); // a field that already has a value is locked
 // Profile and inbox stay hidden until asked for — except a brand-new user, who needs the create form.
 useEffect(()=>{if(!loadingProfile&&!profile&&!flagged)setProfileOpen(true);},[loadingProfile,profile,flagged]);

 useEffect(()=>{(async()=>{
  try{
   // Runs every time the dashboard opens: the signed-in UID must be found in its profile.
   const st=await checkAccount(user);
   if(st.state==="ok"){const d=st.profile;setProfile(d);setU(d.username);setName(d.displayName);setBio(d.bio);setPhoto(d.photoUrl);setWeb(d.websiteUrl);setEmail(d.email);setPhone(d.phone);setEditing(false)}
  }catch(x:any){
   if(isFlagged(x))setFlagged(true);
   else setErr(fail(toast,x,"Unable to load profile"));
  }
  setLoadingProfile(false);
 })();
 const q=query(collection(profileDb,"posts"),where("ownerId","==",user.uid),orderBy("createdAt","desc"),limit(MAX_POSTS));
 return onSnapshot(q,s=>setPosts(s.docs.map(d=>({id:d.id,...d.data()} as any))),e=>setErr(accessText(e,ACCESS_GENERIC)));
 },[user.uid]);

 async function save(e:React.FormEvent){
  e.preventDefault();
  if(flagged)return; // restricted account: no profile changes
  if(profile){ // profile already set up: update the bio only
   setErr("");setSavingProfile(true);
   try{
    const changes:Record<string,string>={bio:bio.trim()};
    // Optional fields left empty at setup can be filled in once; filled ones never change.
    if(!fieldLocked(profile.photoUrl)&&((photo||"").trim()))changes.photoUrl=(photo||"").trim();
    if(!fieldLocked(profile.websiteUrl)&&((web||"").trim()))changes.websiteUrl=(web||"").trim();
    if(!fieldLocked(profile.email)&&((email||"").trim()))changes.email=(email||"").trim();
    if(!fieldLocked(profile.phone)&&((phone||"").trim()))changes.phone=(phone||"").trim();
    await setDoc(doc(profileDb,"profiles",profile.username),{...changes,updatedAt:serverTimestamp()},{merge:true});
    setProfile((prev:any)=>({...prev,...changes}));setEditing(false);toast("success","Profile saved.");
   }catch(x:any){setErr(fail(toast,x,"Unable to save profile"));}
   finally{setSavingProfile(false);}
   return;
  }
  const x=normalizeUsername(u);
  if(!validUsername(x)){setErr("Username must be 3-24 letters, numbers or underscore.");return;}
  if(!name.trim()){setErr("Display name is required.");return;}
  setErr("");setSavingProfile(true);
  try{
   const old=await getDoc(doc(profileDb,"profiles",x));
   if(old.exists()&&old.data().uid!==user.uid){setErr("Username already exists.");toast("error","Username already exists.");return;}
   const p={uid:user.uid,username:x,displayName:name.trim(),bio:bio.trim(),photoUrl:photo.trim(),websiteUrl:web.trim(),email:email.trim(),phone:phone.trim(),updatedAt:serverTimestamp()};
   await setDoc(doc(profileDb,"profiles",x),p,{merge:true});
   await setDoc(doc(profileDb,"users",user.uid),{username:x,updatedAt:serverTimestamp()},{merge:true});
   setProfile((prev:any)=>({...prev,...p}));setEditing(false);toast("success","Profile saved.");
  }catch(x:any){setErr(fail(toast,x,"Unable to save profile"));}
  finally{setSavingProfile(false);}
 }

 function cancelEdit(){
  if(!profile)return;
  setU(profile.username);setName(profile.displayName);setBio(profile.bio||"");setPhoto(profile.photoUrl||"");
  setWeb(profile.websiteUrl||"");setEmail(profile.email||"");setPhone(profile.phone||"");
  setErr("");setEditing(false);
 }

 async function add(e:React.FormEvent){
  e.preventDefault();
  if(posts.length>=MAX_POSTS){setErr("Maximum 100 posts.");return;}
  if(!file&&!validMediaUrl(url)){setErr("Use a valid media URL.");return;}
  setErr("");setAddingPost(true);
  try{
   let mediaUrl=url.trim(),mediaType=mediaTypeFromUrl(url);
   if(file){
    const path=`posts/${user.uid}/${Date.now()}_${file.name}`;
    const fileRef=storageRef(profileStorage,path);
    await uploadBytes(fileRef,file);
    mediaUrl=await getDownloadURL(fileRef);
    mediaType=file.type.startsWith("video")?"video":"image";
   }
   const postRef=await addDoc(collection(profileDb,"posts"),{ownerId:user.uid,mediaUrl,mediaType,caption:caption.trim(),createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
   scheduleAutoDelete({kind:"post",postId:postRef.id});
   setUrl("");setCaption("");setFile(null);toast("success","Post added — it auto-deletes in 24h on this device.");
  }catch(x:any){setErr(fail(toast,x,"Unable to add post"));}
  finally{setAddingPost(false);}
 }

 async function deletePost(postId:string){ try{await cascadePost(postId);}catch(x:any){setErr(fail(toast,x,"Unable to delete post"));throw x;} }

 async function deleteProfileOnly(){
  if(!profile)return;
  const ok=await confirm({
   title:"Delete your public profile?",
   danger:true,
   confirmLabel:"Delete profile",
   requireText:profile.username,
   requireTextHint:`Type your username "${profile.username}" to confirm`,
   body:<>
    <p className="spts-muted">This removes your public profile page and the link between your account and that username.</p>
    <ul className="spts-modal-list">
     <li><b>Removed:</b> your public profile document and the link between your username and account.</li>
     <li><b>Not removed:</b> your posts, likes, comments, and inbox messages. Delete those separately from their own controls if you want them gone.</li>
    </ul>
    <p className="spts-muted">You can create a new profile at any time by visiting the dashboard again.</p>
   </>,
  });
  if(!ok)return;
  setDeletingProfile(true);
  try{
   await deleteDoc(doc(profileDb,"profiles",profile.username));
   await deleteDoc(doc(profileDb,"users",user.uid));
   setProfile(null);setU("");setName("");setBio("");setPhoto("");setWeb("");setEmail("");setPhone("");setEditing(true);
   toast("success","Profile deleted.");
  }catch(x:any){setErr(fail(toast,x,"Unable to delete profile"));}
  finally{setDeletingProfile(false);}
 }

 return <main className="spts-page"><header><h1>Dashboard</h1><button className="spts-ghost" onClick={()=>signOut(profileAuth)}>Log out</button></header>

 <div className="spts-dash-actions">
  {!flagged&&<button type="button" aria-expanded={profileOpen} onClick={()=>setProfileOpen(o=>!o)}>{profileOpen?"Hide profile":profile||loadingProfile?"Manage profile":"Create profile"}</button>}
  <button type="button" aria-expanded={inboxOpen} onClick={()=>setInboxOpen(o=>!o)}>{inboxOpen?"Hide inbox":"Go to inbox"}</button>
 </div>

 {flagged&&<section className="spts-card">
  <div className="spts-card-head"><h2>Account restricted</h2></div>
  <AccountFlagNotice uid={user.uid}/>
 </section>}

 {profileOpen&&!flagged&&<section className="spts-card">
  <div className="spts-card-head">
   <h2>Profile</h2>
   <div className="spts-card-head-badges">
    {!editing&&profile&&<Hint k="live" plain className="spts-badge">Live</Hint>}
    {isPremium&&<Hint k="premium" plain className="spts-premium-tag">Premium</Hint>}
    {!isPremium&&profile&&<UpgradeButton user={user}/>}
   </div>
  </div>
  {loadingProfile&&<p className="spts-muted">Loading…</p>}

  {!loadingProfile&&!editing&&profile&&<div className="spts-profile-summary">
   {profile.photoUrl&&<img className="spts-avatar-sm" src={profile.photoUrl} alt=""/>}
   <div>
    <p className="spts-name">{profile.displayName} <span className="spts-muted">@{profile.username}</span></p>
    {profile.bio&&<p className="spts-muted"><ClampText text={profile.bio} plain/></p>}
   </div>
   <div className="spts-profile-summary-actions">
    <a href={`/profile/${profile.username}`}>View public profile</a>
    <button className="spts-ghost" onClick={()=>setEditing(true)}>Edit</button>
    <SpinnerButton className="spts-danger" busy={deletingProfile} busyLabel="Deleting…" onClick={deleteProfileOnly}>Delete profile</SpinnerButton>
   </div>
  </div>}

  {!loadingProfile&&!editing&&!profile&&<div className="spts-empty">
   <p className="spts-muted">You don't have a public profile yet.</p>
   <button onClick={()=>setEditing(true)}>Create profile</button>
  </div>}

  {!loadingProfile&&editing&&<form onSubmit={save}>
   {locked&&<p className="spts-muted">Only your bio and empty fields can be edited. To change filled fields,{" "}
    <a className="spts-link" href={supportUrl(`Hi, I'd like to change my profile details. Username: @${profile.username}`)} target="_blank" rel="noreferrer">contact support</a>.</p>}
   <label>Username<input required={!locked} readOnly={locked} className={locked?"spts-readonly":undefined} placeholder="yourname" value={u} onChange={e=>setU(e.target.value)} disabled={savingProfile}/></label>
   <label>Display name<input required={!locked} readOnly={locked} className={locked?"spts-readonly":undefined} placeholder="Your name" value={name} onChange={e=>setName(e.target.value)} disabled={savingProfile}/></label>
   <label>Bio<textarea maxLength={1000} placeholder="Tell visitors about yourself" value={bio} onChange={e=>setBio(e.target.value)} disabled={savingProfile}/></label>
   <label>Profile photo URL<input readOnly={fieldLocked(profile?.photoUrl)} className={fieldLocked(profile?.photoUrl)?"spts-readonly":undefined} placeholder="https://…" value={photo} onChange={e=>setPhoto(e.target.value)} disabled={savingProfile}/></label>
   <label>Website URL<input readOnly={fieldLocked(profile?.websiteUrl)} className={fieldLocked(profile?.websiteUrl)?"spts-readonly":undefined} placeholder="https://…" value={web} onChange={e=>setWeb(e.target.value)} disabled={savingProfile}/></label>
   <label>Public email<input type="email" readOnly={fieldLocked(profile?.email)} className={fieldLocked(profile?.email)?"spts-readonly":undefined} placeholder="Shown on your public profile" value={email} onChange={e=>setEmail(e.target.value)} disabled={savingProfile}/></label>
   <label>Public phone<input readOnly={fieldLocked(profile?.phone)} className={fieldLocked(profile?.phone)?"spts-readonly":undefined} placeholder="Shown on your public profile" value={phone} onChange={e=>setPhone(e.target.value)} disabled={savingProfile}/></label>
   <div className="spts-form-actions">
    <SpinnerButton type="submit" busy={savingProfile} busyLabel="Saving…">{profile?"Save changes":"Create profile"}</SpinnerButton>
    {profile&&<button type="button" className="spts-ghost" onClick={cancelEdit} disabled={savingProfile}>Cancel</button>}
   </div>
  </form>}
 </section>}

 {inboxOpen&&<Messages user={user}/>}

 {profile&&<AdRequest user={user} profile={profile}/>}

 <section className="spts-card">
  <div className="spts-card-head"><h2>Posts</h2><Hint k="postCount" plain className="spts-badge">{posts.length}/{MAX_POSTS}</Hint></div>
  <p className="spts-muted">{isPremium?"Paste a URL, or upload a file directly.":"URLs only — no uploads. Upgrade to Premium to upload files directly."}</p>
  <AutoDeleteNotice text="Posts, with their likes and comments, are removed 24h after you add them."/>
  <form onSubmit={add}>
   <label>Photo/video URL<input required={!isPremium} placeholder="https://…" value={url} onChange={e=>setUrl(e.target.value)} disabled={addingPost||!!file}/></label>
   {isPremium&&<label className="spts-fileupload-row">Or upload a file <span className="spts-premium-tag spts-premium-tag-sm">Premium</span>
    <input type="file" accept="image/*,video/*" onChange={e=>setFile(e.target.files?.[0]||null)} disabled={addingPost}/>
   </label>}
   <label>Caption<input maxLength={500} placeholder="Optional caption" value={caption} onChange={e=>setCaption(e.target.value)} disabled={addingPost}/></label>
   <SpinnerButton type="submit" busy={addingPost} busyLabel={file?"Uploading…":"Posting…"} disabled={!url.trim()&&!file}>Add post</SpinnerButton>
  </form>
  {posts.length===0&&<p className="spts-muted">No posts yet.</p>}
  {posts.length>0&&<>
   <PostCard key={posts[0].id} post={posts[0]} user={user} canDeletePost={false} onDeletePost={()=>deletePost(posts[0].id)}/>
   <p className="spts-muted spts-dashboard-post-hint">Showing your latest post. Manage or delete posts from your public profile, which you own.</p>
   {profile&&<a className="spts-see-more" href={`/profile/${profile.username}`}>See all posts on your public profile <Ico d={ICON.next}/></a>}
  </>}
 </section>

 {err&&<p className="spts-error"><ErrText text={err}/></p>}</main>
}

/* ------------------------------------------------------------------ *
 * PublicProfile
 * ------------------------------------------------------------------ */
const POST_PREVIEW_COUNT=3;
function PublicProfile({username,user}:{username:string;user:User|null}){
 const [p,setP]=useState<any>(null),[posts,setPosts]=useState<any[]>([]),[msg,setMsg]=useState(""),[err,setErr]=useState(""),[count,setCount]=useState(0),[notFound,setNotFound]=useState(false);
 const [sending,setSending]=useState(false);
 const [pendingDeleteId,setPendingDeleteId]=useState<string|null>(null);
 const [showAllPosts,setShowAllPosts]=useState(false);
 const [copied,setCopied]=useState(false);
 const [postsOpen,setPostsOpen]=useState(false),[msgOpen,setMsgOpen]=useState(false),[avatarOpen,setAvatarOpen]=useState(false);
 const confirm=useConfirm();const toast=useToast();const hint=useHint();

 // On small screens Posts / Message open full screen; lock the page behind them while they're open.
 useEffect(()=>{
  if(!(postsOpen||msgOpen))return;
  const el=document.documentElement;
  el.classList.add("spts-panel-open");
  return ()=>el.classList.remove("spts-panel-open");
 },[postsOpen,msgOpen]);

 useEffect(()=>{(async()=>{try{
  const s=await getDoc(doc(profileDb,"profiles",normalizeUsername(username)));
  if(!s.exists()){setNotFound(true);return;}
  setP(s.data());
  prefetchAd(s.data().username||normalizeUsername(username),!!s.data().premium); // so "See portfolio" opens instantly
  const q=query(collection(profileDb,"posts"),where("ownerId","==",s.data().uid),orderBy("createdAt","desc"),limit(MAX_POSTS));
  onSnapshot(q,x=>setPosts(x.docs.map(d=>({id:d.id,...d.data()} as any))),e=>setErr(accessText(e,ACCESS_GENERIC)));
 }catch(x:any){setErr(fail(toast,x,"Unable to load profile"));}})()},[username]);

 async function send(){
  setErr("");
  if(!p)return;
  if(msg.trim().length<MSG_MIN||msg.trim().length>MSG_MAX)return setErr(`Use ${MSG_MIN}–${MSG_MAX} characters.`);
  if(count>=MAX_MESSAGES)return setErr("Conversation limit reached.");
  setSending(true);
  try{
   const visitor=getDeviceId(),cid=`${p.uid}_${visitor}`,cr=doc(profileDb,"conversations",cid),
    s=await getDoc(cr),n=s.exists()?s.data().messageCount||0:0;
   if(n>=MAX_MESSAGES){setErr("Conversation limit reached.");return;}
   const e=await encryptMessage(msg.trim());
   const isNewConversation=!s.exists();
   await setDoc(cr,{profileOwnerId:p.uid,visitorId:visitor,messageCount:increment(1),createdAt:isNewConversation?serverTimestamp():s.data().createdAt,updatedAt:serverTimestamp()},{merge:true});
   if(isNewConversation)scheduleAutoDelete({kind:"conversation",conversationId:cid});
   const messageRef=await addDoc(collection(cr,"messages"),{senderId:visitor,ciphertext:e.ciphertext,time:e.time,deviceId:e.deviceId,iv:e.iv,createdAt:serverTimestamp()});
   scheduleAutoDelete({kind:"message",conversationId:cid,messageId:messageRef.id});
   setMsg("");setCount(count+1);
  }catch(x:any){setErr(fail(toast,x,"Unable to send"));}
  finally{setSending(false);}
 }

 async function deletePost(postId:string){
  const ok=await confirm({
   title:"Delete this post?",
   body:<p className="spts-muted">This removes the post and its likes and comments. Nothing else is affected.</p>,
   confirmLabel:"Delete post",danger:true,
  });
  if(!ok)return;
  setPendingDeleteId(postId);
  try{ await cascadePost(postId);toast("success","Post deleted."); }
  catch(x:any){fail(toast,x,"Unable to delete post");}
  finally{setPendingDeleteId(null);}
 }
 if(notFound)return <main className="spts-public"><div className="spts-public-status"><h1>Profile not found</h1><p className="spts-muted">This username doesn't have a public profile.</p><a className="spts-ghost spts-link-btn" href="/profiles">Get your own profile</a></div></main>;
 if(!p)return <main className="spts-public"><div className="spts-public-status"><span className="spts-spinner spts-spinner-lg" aria-hidden="true"/><p className="spts-muted">Loading profile…</p></div></main>;
 const contacts=detectContacts(p.bio||"");
 const canDeletePosts=!!user&&user.uid===p.uid;
 const visiblePosts=showAllPosts?posts:posts.slice(0,POST_PREVIEW_COUNT);
 const hiddenPostCount=posts.length-visiblePosts.length;
 function shareProfile(){
  navigator.clipboard?.writeText(location.href);
  setCopied(true);
  setTimeout(()=>setCopied(false),2000);
 }
 // Layout: the profile is one column; Posts / Message open as a second panel.
 // Desktop: profile on the left, panel on the right. Mobile: the profile fills the screen and the panel opens full screen.
 return <main className={`spts-public${p.premium?" spts-premium":""}`}>
 <div className={`spts-profile-layout${postsOpen||msgOpen?" spts-has-panel":""}`}>

 <section className="spts-profile-hero">
  {p.photoUrl
   ?<button type="button" className="spts-avatar-btn" onClick={()=>setAvatarOpen(true)} aria-label="View profile picture full screen"><img className="spts-avatar-lg" src={p.photoUrl} alt={p.displayName}/></button>
   :<div className="spts-avatar-lg spts-avatar-fallback" aria-hidden="true">{(p.displayName||"?").trim().charAt(0).toUpperCase()}</div>}
  <h1 className="spts-profile-name">{p.displayName}</h1>
  <p className="spts-profile-handle">@{p.username}</p>
  {p.premium&&<Hint k="premium" plain className="spts-premium-badge">Premium</Hint>}
  {p.bio&&<p className="spts-bio spts-profile-bio"><ClampText text={p.bio}/></p>}
  {(p.websiteUrl||p.email||p.phone)&&<div className="spts-profile-meta">
   {p.websiteUrl&&<a className="spts-meta-chip" href={p.websiteUrl} target="_blank" rel="noreferrer" {...hint.props("website")}>Website</a>}
   {p.email&&<a className="spts-meta-chip" href={`mailto:${p.email}`} {...hint.props("email")}>Email</a>}
   {p.phone&&<a className="spts-meta-chip" href={`tel:${p.phone}`} {...hint.props("phone")}>Phone</a>}
  </div>}
  {/* One panel at a time: while posts or the message box are open, every other button hides until it is closed. */}
  <div className="spts-profile-hero-actions">
   {!msgOpen&&<button type="button" aria-expanded={postsOpen} onClick={()=>setPostsOpen(o=>!o)} {...hint.props("seePosts")}>{postsOpen?"Hide posts":"See posts"}</button>}
   {!postsOpen&&<button type="button" aria-expanded={msgOpen} onClick={()=>setMsgOpen(o=>!o)} {...hint.props("message")}>{msgOpen?"Hide message":"Message"}</button>}
   {!postsOpen&&!msgOpen&&<a className="spts-link-btn spts-ad-btn" href={`/profile/${p.username}/ad`} {...hint.props("portfolio")}>See portfolio</a>}
  </div>
  {!postsOpen&&!msgOpen&&<div className="spts-profile-hero-actions spts-hero-actions-2">
   <button type="button" className="spts-ghost" onClick={shareProfile} {...hint.props("share")}>{copied?<><Ico d={ICON.check}/> Link copied</>:"Share profile"}</button>
   <a className="spts-ghost spts-link-btn" href="/profiles" {...hint.props("getOwn")}>Get your own profile</a>
  </div>}
  <small className="spts-muted spts-contact-note"><Hint k="contactNote">{contacts.urls.length+contacts.emails.length+contacts.phones.length} contact/link items detected in bio</Hint></small>
 </section>

 {postsOpen&&<aside className="spts-profile-panel" aria-label="Posts">
  <div className="spts-panel-bar">
   <div className="spts-panel-title"><h2>Posts</h2><span className="spts-badge">{posts.length}</span></div>
   <button type="button" className="spts-ghost spts-panel-close" onClick={()=>setPostsOpen(false)} aria-label="Hide posts"><Ico d={ICON.close}/></button>
  </div>
  <section className="spts-card spts-section">
   {posts.length===0&&<p className="spts-muted spts-empty-text">No posts yet.</p>}
   <div className="spts-post-grid">
    {visiblePosts.map(x=><PostCard key={x.id} post={x} user={user} canDeletePost={canDeletePosts} onDeletePost={()=>deletePost(x.id)}/>)}
   </div>
   {!showAllPosts&&hiddenPostCount>0&&<button type="button" className="spts-see-more" onClick={()=>setShowAllPosts(true)}>See {hiddenPostCount} more</button>}
   {showAllPosts&&posts.length>POST_PREVIEW_COUNT&&<button type="button" className="spts-see-more spts-ghost" onClick={()=>setShowAllPosts(false)}>Show less</button>}
  </section>
 </aside>}

 {msgOpen&&<aside className="spts-profile-panel spts-profile-panel-chat" aria-label="Message">
  <div className="spts-panel-bar">
   <div className="spts-panel-title"><h2>Message</h2></div>
   <button type="button" className="spts-ghost spts-panel-close" onClick={()=>setMsgOpen(false)} aria-label="Hide message"><Ico d={ICON.close}/></button>
  </div>
  <section className="spts-card spts-section spts-chat">
   <div className="spts-chat-head">
    {p.photoUrl?<img className="spts-chat-avatar" src={p.photoUrl} alt=""/>:<div className="spts-chat-avatar" aria-hidden="true">{(p.displayName||"?").trim().charAt(0).toUpperCase()}</div>}
    <div><strong>{p.displayName}</strong><small><Hint k="anonymous">Anonymous</Hint> · <Hint k="autodelete">auto-deletes in 24h</Hint></small></div>
   </div>

   <VisitorChat conversationId={`${p.uid}_${getDeviceId()}`}/>

   <div className="spts-chat-compose">
    <AutoTextarea maxLength={MSG_MAX} value={msg} onChange={e=>setMsg(e.target.value)}
     onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();if(msg.trim()&&!sending)send();}}}
     placeholder="Message…" disabled={sending}/>
    <SpinnerButton className="spts-chat-send" busy={sending} busyLabel="" onClick={send} disabled={!msg.trim()} title="Send"><Ico d={ICON.send}/></SpinnerButton>
   </div>
   <div className="spts-chat-foot"><Hint k="msgLimit">{MSG_MIN}–{MSG_MAX} characters</Hint><span>{msg.length}/{MSG_MAX}</span></div>
   {err&&<div className="spts-error-box" role="alert"><span className="spts-error-icon" aria-hidden="true">!</span><span><ErrText text={err}/></span></div>}
  </section>
 </aside>}

 </div>
 {avatarOpen&&p.photoUrl&&<MediaLightbox post={{mediaUrl:p.photoUrl,caption:p.displayName}} isVideo={false} autoCloseMs={10000} onClose={()=>setAvatarOpen(false)}/>}
 </main>
}

/* ------------------------------------------------------------------ *
 * Premium upgrade handshake
 *
 * 1. Any "Upgrade to Premium" button first builds { username, HH:MM:SS, epoch ms },
 *    encrypts it with a key derived from the signed-in email (AES-GCM), saves the blob
 *    in Firestore (upgradeintents/{uid}), caches the same time on this device, and only
 *    then sends the user to Paystack.
 * 2. Paystack redirects to "…/profile/upgradesuccessConfirm". UpgradeSuccess reads the
 *    blob back, decrypts it with the email, and checks it matches the username, matches
 *    the time cached on this device, and is under 15 minutes old. Only then is premium set.
 *
 * Note: this proves the upgrade was started from this account and device just now — it does
 * not prove Paystack received a payment (that needs a Paystack webhook / verify call).
 * ------------------------------------------------------------------ */
const UPGRADE_CACHE_KEY="spts_upgrade_v1:";
const UPGRADE_TTL_MS=15*60*1000;
type UpgradeRec={u:string;t:string;at:number};

const _te=new TextEncoder(),_td=new TextDecoder();
const _b64=(u:Uint8Array)=>btoa(String.fromCharCode(...u));
const _unb64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function emailKey(email:string){
 const base=await crypto.subtle.importKey("raw",_te.encode(email.trim().toLowerCase()),"PBKDF2",false,["deriveKey"]);
 return crypto.subtle.deriveKey(
  {name:"PBKDF2",salt:_te.encode("spts-upgrade-v1"),iterations:100000,hash:"SHA-256"},
  base,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
async function sealUpgrade(email:string,rec:UpgradeRec){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const ct=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},await emailKey(email),_te.encode(JSON.stringify(rec))));
 return `${_b64(iv)}.${_b64(ct)}`;
}
async function openUpgrade(email:string,blob:string):Promise<UpgradeRec>{
 const [iv,ct]=blob.split(".");
 const pt=await crypto.subtle.decrypt({name:"AES-GCM",iv:_unb64(iv)},await emailKey(email),_unb64(ct));
 return JSON.parse(_td.decode(pt));
}

async function beginUpgrade(user:User){
 if(!user.email)throw new Error("Your account has no email address.");
 const uname=await requireLinkedProfile(user);
 const d=new Date(),p=(n:number)=>String(n).padStart(2,"0");
 const rec:UpgradeRec={u:uname,t:`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,at:Date.now()};
 const blob=await sealUpgrade(user.email,rec);
 await setDoc(doc(profileDb,"upgradeintents",user.uid),{blob,createdAt:serverTimestamp()});
 localStorage.setItem(UPGRADE_CACHE_KEY+user.uid,JSON.stringify(rec));
 noteAccessError(null);
 window.location.assign(`${PAYSTACK_UPGRADE_URL}?email=${encodeURIComponent(user.email)}`);
}

// Every upgrade button in the app.
function UpgradeButton({user,className}:{user:User;className?:string}){
 const [busy,setBusy]=useState(false),[flagged,setFlagged]=useState(false);
 const toast=useToast();const hint=useHint();
 async function go(){
  setBusy(true);
  try{ await beginUpgrade(user); } // navigates away on success
  catch(x:any){
   setBusy(false);
   if(isFlagged(x)){setFlagged(true);return;}
   fail(toast,x,"Couldn't start the upgrade. Please try again.");
  }
 }
 return <>
  <SpinnerButton className={`spts-upgrade-btn${className?" "+className:""}`} busy={busy} busyLabel="Please wait…" onClick={go} extra={hint.props("upgrade")}>Upgrade to Premium</SpinnerButton>
  {flagged&&<div className="spts-modal-backdrop" role="dialog" aria-modal="true" onClick={()=>setFlagged(false)}>
   <div className="spts-modal spts-modal-wide" onClick={e=>e.stopPropagation()}>
    <h3 className="spts-modal-title">Account restricted</h3>
    <div className="spts-modal-body"><AccountFlagNotice uid={user.uid}/></div>
    <div className="spts-modal-actions"><button type="button" className="spts-ghost" onClick={()=>setFlagged(false)}>Close</button></div>
   </div>
  </div>}
 </>;
}

/* ------------------------------------------------------------------ *
 * UpgradeSuccess — landing spot for Paystack's redirect after payment
 * ("…/profile/upgradesuccessConfirm"). Verifies the handshake above.
 * ------------------------------------------------------------------ */
function UpgradeSuccess({user}:{user:User|null}){
 const [status,setStatus]=useState<"working"|"done"|"error">("working");
 // plain = our own message; retry = first Firebase access error; support = same access error repeated; flagged = UID not linked to a profile
 const [errKind,setErrKind]=useState<"plain"|"retry"|"support"|"flagged">("plain");
 const [err,setErr]=useState("");
 const ran=useRef(false);
 const toast=useToast();

 useEffect(()=>{(async()=>{
  if(!user){setStatus("error");setErr("Log in with the account you upgraded, then reopen this page.");return;}
  if(ran.current)return;
  ran.current=true;
  try{
   if(!user.email)throw new Error("Your account has no email address.");
   const uname=await requireLinkedProfile(user);

   const intentRef=doc(profileDb,"upgradeintents",user.uid);
   const [snap,cachedRaw]=[await getDoc(intentRef),localStorage.getItem(UPGRADE_CACHE_KEY+user.uid)];
   if(!snap.exists()||!cachedRaw)throw new Error("No upgrade in progress. Tap Upgrade to Premium to start.");

   let rec:UpgradeRec,cached:UpgradeRec;
   try{ rec=await openUpgrade(user.email,String(snap.data().blob)); cached=JSON.parse(cachedRaw); }
   catch{ throw new Error("Couldn't verify this upgrade. Please start it again."); }

   const age=Date.now()-rec.at;
   if(rec.u!==uname||rec.u!==cached.u||rec.t!==cached.t||rec.at!==cached.at)throw new Error("Couldn't verify this upgrade. Please start it again.");
   if(age<-60000||age>UPGRADE_TTL_MS)throw new Error("This upgrade expired (over 15 minutes). Please start it again.");

   await setDoc(doc(profileDb,"profiles",uname),{premium:true,updatedAt:serverTimestamp()},{merge:true});
   // single use
   try{ await deleteDoc(intentRef); }catch{}
   try{ localStorage.removeItem(UPGRADE_CACHE_KEY+user.uid); }catch{}
   noteAccessError(null);
   setStatus("done");
   toast("success","You're upgraded to Premium.");
  }catch(x:any){
   setStatus("error");
   if(isFlagged(x)){noteAccessError(null);setErrKind("flagged");return;}
   const code=firebaseAccessCode(x);
   if(code){setErrKind(noteAccessError(code)?"support":"retry");setErr(ACCESS_GENERIC);toast("error",ACCESS_GENERIC);return;}
   noteAccessError(null);
   setErrKind("plain");setErr(fail(toast,x,"Unable to confirm your upgrade."));
  }
 })();},[user]);

 return <main className="spts-page"><section className="spts-card spts-upgrade-confirm">
  {status==="working"&&<><span className="spts-spinner spts-spinner-lg" aria-hidden="true"/><p className="spts-muted">Confirming your payment…</p></>}
  {status==="done"&&<>
   <h2>You're Premium</h2>
   <p className="spts-muted">Your premium public-profile theme, direct file uploads and portfolio upload are unlocked.</p>
   <a className="spts-ghost spts-link-btn" href="/">Back to dashboard</a>
  </>}
  {status==="error"&&errKind==="flagged"&&<>
   <h2>Account restricted</h2>
   <AccountFlagNotice uid={user?.uid}/>
   <a className="spts-ghost spts-link-btn" href="/">Back to dashboard</a>
  </>}
  {status==="error"&&errKind!=="flagged"&&<>
   <h2>Couldn't confirm your upgrade</h2>
   <p className="spts-error"><ErrText text={err}/></p>
   {errKind==="retry"&&<button type="button" onClick={()=>window.location.reload()}>Try again</button>}
   {errKind!=="retry"&&<p className="spts-muted">{errKind==="support"?"Still not working? ":""}Already paid? <a className="spts-link" href={supportUrl("Hi, I paid for Premium but the upgrade didn't confirm.")} target="_blank" rel="noreferrer">Contact support</a>.</p>}
   <a className="spts-ghost spts-link-btn" href="/">Back to dashboard</a>
  </>}
 </section></main>;
}

/* ------------------------------------------------------------------ *
 * Portfolio (internal names, the /ad route and Firestore paths still say "ad")
 *
 * Firestore layout:
 *   profiles/{username}/ad/code          -> { html, startDate?, endDate? }
 *        Basic profiles: added by hand in the Firestore console after the
 *        owner sends a request. Premium profiles: the owner uploads their
 *        own .html file from the dashboard (PortfolioUpload), choosing a
 *        duration of at least 1 week; that writes { html, startDate, endDate }
 *        to this same doc, and Remove stays disabled while it is live. startDate / endDate are OPTIONAL
 *        "YYYY-MM-DD" strings (endDate is the last day the portfolio shows).
 *        Outside that window it counts as not live, so it "expires" and a
 *        basic owner can request again. Public read. Client writes: the
 *        Premium owner of the profile only (see the rules note in the
 *        hand-off), never anyone else.
 *   adrequest/{ownerUid}/messages/{id}   -> the owner's request
 *        { ownerId, username, fullName, mobile, message, durationDays,
 *          liveDate, endDate, status:"pending", createdAt }
 *        Owner needs create + read on their own uid. The same details are
 *        also emailed through FormSubmit.co.
 *
 * Public link: /profile/{username}/ad  (AdView below)
 * ------------------------------------------------------------------ */
const AD_REQUEST_EMAIL="infospteamstudio@gmail.com";
const AD_MIN_DESC=10,AD_MAX_DESC=2000;
const AD_DURATIONS=[
 {days:1,label:"1 day"},{days:3,label:"3 days"},{days:7,label:"1 week"},
 {days:14,label:"2 weeks"},{days:30,label:"1 month"},{days:90,label:"3 months"},
];
// Premium portfolios run for a set duration like basic ones, but never less than one week.
const PORTFOLIO_DURATIONS=AD_DURATIONS.filter(d=>d.days>=7);
const AD_CACHE_KEY="spts_ad_v1:",AD_LASTREQ_KEY="spts_adreq_v1:",AD_PREMIUM_KEY="spts_adpremium_v1:";
// Premium owners upload their own portfolio: one .html file, strictly under 0.5 MB.
const PORTFOLIO_MAX_BYTES=Math.floor(0.5*1024*1024);

function todayLocal(){ return new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10); }
function addDaysISO(iso:string,n:number){const d=new Date(`${iso}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
// A 1-week ad starting Monday runs Mon..Sun, so the end date is start + (days-1).
function endDateFor(start:string,days:number){ return addDaysISO(start,days-1); }
function prettyDate(iso:string){
 return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined,{weekday:"short",day:"numeric",month:"short",year:"numeric",timeZone:"UTC"});
}

type AdDoc={html:string;startDate?:string;endDate?:string};
function parseAd(d:any):AdDoc|null{
 if(!d||typeof d.html!=="string"||!d.html.trim())return null;
 return {html:d.html,startDate:typeof d.startDate==="string"?d.startDate:undefined,endDate:typeof d.endDate==="string"?d.endDate:undefined};
}
function adPhase(a:AdDoc,today:string):"live"|"scheduled"|"expired"{
 if(a.endDate&&a.endDate<today)return "expired";
 if(a.startDate&&a.startDate>today)return "scheduled";
 return "live";
}
function sameAd(a:AdDoc|null,b:AdDoc|null){ return JSON.stringify(a)===JSON.stringify(b); }

// The ad is cached in localStorage so a refresh paints it instantly (from the
// first render) and Firestore only refreshes it quietly in the background.
function readAdCache(u:string):AdDoc|null{
 try{const r=localStorage.getItem(AD_CACHE_KEY+u);return r?parseAd(JSON.parse(r)):null;}catch{return null;}
}
function writeAdCache(u:string,a:AdDoc|null){
 try{if(a)localStorage.setItem(AD_CACHE_KEY+u,JSON.stringify(a));else localStorage.removeItem(AD_CACHE_KEY+u);}catch{}
}
async function fetchAd(u:string):Promise<AdDoc|null>{
 const s=await getDoc(doc(profileDb,"profiles",u,"ad","code"));
 return s.exists()?parseAd(s.data()):null;
}
// Whether the profile is Premium decides if the portfolio viewer offers the optional "Open in new tab" button.
function readPremiumCache(u:string):boolean|null{
 try{const r=localStorage.getItem(AD_PREMIUM_KEY+u);return r===null?null:r==="1";}catch{return null;}
}
function writePremiumCache(u:string,v:boolean){ try{localStorage.setItem(AD_PREMIUM_KEY+u,v?"1":"0");}catch{} }
async function fetchPremium(u:string):Promise<boolean>{
 const s=await getDoc(doc(profileDb,"profiles",u));
 return s.exists()&&s.data().premium===true;
}
// Warm the cache (used by the public profile so "See portfolio" opens instantly).
function prefetchAd(u:string,premium?:boolean){
 if(typeof premium==="boolean")writePremiumCache(u,premium);
 fetchAd(u).then(a=>writeAdCache(u,a)).catch(()=>{});
}

// Premium upload: the file is checked, read as UTF-8 text and normalised (BOM and outer whitespace
// removed) into the html string that goes into profiles/{username}/ad/code.
function checkPortfolioFile(f:File):string{
 if(!/\.html?$/i.test(f.name))return "Choose an .html file.";
 if(f.size===0)return "That file is empty.";
 if(f.size>=PORTFOLIO_MAX_BYTES)return "That file is too big. Keep it under 0.5 MB.";
 return "";
}
async function readPortfolioFile(f:File):Promise<string>{
 const bad=checkPortfolioFile(f);
 if(bad)throw new Error(bad);
 let html:string;
 try{ html=new TextDecoder("utf-8",{fatal:true}).decode(await f.arrayBuffer()); }
 catch{ throw new Error("Couldn't read that file. Save it as UTF-8 and try again."); }
 html=html.replace(/^\uFEFF/,"").trim();
 if(!/<[a-z!][^>]*>/i.test(html))throw new Error("That doesn't look like an HTML file.");
 if(new TextEncoder().encode(html).length>=PORTFOLIO_MAX_BYTES)throw new Error("That file is too big. Keep it under 0.5 MB.");
 return html;
}

// Last request the owner made — the "waiting period" is derived from it.
type AdReqRec={startDate:string;endDate:string;createdMs:number};
function readLastReq(uid:string):AdReqRec|null{
 try{const r=localStorage.getItem(AD_LASTREQ_KEY+uid);return r?JSON.parse(r):null;}catch{return null;}
}
function writeLastReq(uid:string,r:AdReqRec){ try{localStorage.setItem(AD_LASTREQ_KEY+uid,JSON.stringify(r));}catch{} }
function reqRecFrom(d:any):AdReqRec|null{
 const start:string=d?.liveDate||d?.startDate||"";
 const days=Number(d?.durationDays)||0;
 const end:string=d?.endDate||(start&&days?endDateFor(start,days):"");
 if(!start||!end)return null;
 return {startDate:start,endDate:end,createdMs:d?.createdAt?.toMillis?.()??0};
}

type AdStatus={phase:"none"|"waiting"|"scheduled"|"live"|"expired";startDate?:string;endDate?:string};
function useAdStatus(user:User,username:string,bump:number):AdStatus|null{
 const [status,setStatus]=useState<AdStatus|null>(null);
 useEffect(()=>{
  let alive=true;
  (async()=>{
   const today=todayLocal();
   let ad:AdDoc|null=null;
   try{ad=await fetchAd(username);writeAdCache(username,ad);}catch{}
   let best:AdReqRec|null=readLastReq(user.uid);
   try{
    const q=await getDocs(query(collection(profileDb,"adrequest",user.uid,"messages"),orderBy("createdAt","desc"),limit(1)));
    const r=q.empty?null:reqRecFrom(q.docs[0].data());
    if(r&&(!best||r.createdMs>=best.createdMs))best=r;
   }catch{ /* rules may not allow reads — the local record still works */ }
   if(!alive)return;
   const phase=ad?adPhase(ad,today):null;
   if(ad&&(phase==="live"||phase==="scheduled")){setStatus({phase,startDate:ad.startDate,endDate:ad.endDate});return;}
   if(best&&best.endDate>=today){setStatus({phase:"waiting",startDate:best.startDate,endDate:best.endDate});return;}
   if(ad&&phase==="expired"){setStatus({phase:"expired",endDate:ad.endDate});return;}
   setStatus({phase:"none"});
  })();
  return ()=>{alive=false};
 },[user.uid,username,bump]);
 return status;
}

// The signed-in viewer's own profile (used to prefill the request form).
function useOwnProfile(user:User|null){
 const [state,setState]=useState<{loading:boolean;profile:any|null}>({loading:!!user,profile:null});
 useEffect(()=>{
  if(!user){setState({loading:false,profile:null});return;}
  let alive=true;
  setState(s=>({...s,loading:true}));
  (async()=>{
   try{
    const us=await getDoc(doc(profileDb,"users",user.uid));
    if(us.exists()){
     const p=await getDoc(doc(profileDb,"profiles",us.data().username));
     if(p.exists()){if(alive)setState({loading:false,profile:p.data()});return;}
    }
   }catch{}
   if(alive)setState({loading:false,profile:null});
  })();
  return ()=>{alive=false};
 },[user?.uid]);
 return state;
}

/* Small modal with the request form. Emails the details through FormSubmit.co,
 * then records the request in Firestore so the dashboard can show the waiting
 * period. */
function AdRequestModal({user,profile,onClose,onSent}:{user:User;profile:any;onClose:()=>void;onSent:()=>void}){
 const toast=useToast();
 const today=todayLocal();
 const [name,setName]=useState<string>(profile.displayName||user.displayName||"");
 const [mobile,setMobile]=useState<string>(profile.phone||"");
 const [desc,setDesc]=useState("");
 const [days,setDays]=useState(7);
 const [start,setStart]=useState("");
 const [sending,setSending]=useState(false),[err,setErr]=useState("");
 const end=start?endDateFor(start,days):"";
 const durationLabel=AD_DURATIONS.find(d=>d.days===days)?.label||`${days} days`;

 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{if(e.key==="Escape"&&!sending)onClose();};
  window.addEventListener("keydown",onKey);
  return ()=>window.removeEventListener("keydown",onKey);
 },[sending,onClose]);

 async function submit(e:React.FormEvent){
  e.preventDefault();
  if(!name.trim())return setErr("Full name is required.");
  if(mobile.replace(/\D/g,"").length<7)return setErr("Enter a valid mobile number.");
  if(desc.trim().length<AD_MIN_DESC)return setErr(`Describe the portfolio in at least ${AD_MIN_DESC} characters.`);
  if(!start||start<today)return setErr("Pick a start date that is today or later.");
  setErr("");setSending(true);
  try{
   const origin=typeof location!=="undefined"?location.origin:"";
   const res=await fetch(`https://formsubmit.co/ajax/${AD_REQUEST_EMAIL}`,{
    method:"POST",
    headers:{"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify({
     _subject:`Portfolio request from @${profile.username}`,
     _template:"table",
     _captcha:"false",
     email:user.email||"",
     "Full name":name.trim(),
     Mobile:mobile.trim(),
     Description:desc.trim(),
     Duration:durationLabel,
     "Start date":start,
     "End date":end,
     Username:`@${profile.username}`,
     "Profile link":`${origin}/profile/${profile.username}`,
     "Portfolio link":`${origin}/profile/${profile.username}/ad`,
    }),
   });
   const data:any=await res.json().catch(()=>({}));
   if(!res.ok||data.success===false||data.success==="false")throw new Error(data.message||"Couldn't send your request. Please try again.");

   // Record it so the dashboard can show the waiting period (best-effort).
   try{
    await addDoc(collection(profileDb,"adrequest",user.uid,"messages"),{
     ownerId:user.uid,username:profile.username,fullName:name.trim(),mobile:mobile.trim(),
     message:desc.trim(),durationDays:days,liveDate:start,endDate:end,status:"pending",createdAt:serverTimestamp(),
    });
   }catch{}
   writeLastReq(user.uid,{startDate:start,endDate:end,createdMs:Date.now()});
   toast("success","Portfolio request sent.");
   onSent();
  }catch(x:any){setErr(fail(toast,x,"Unable to send request"));}
  finally{setSending(false);}
 }

 return <div className="spts-modal-backdrop" role="dialog" aria-modal="true" onClick={()=>{if(!sending)onClose();}}>
  <div className="spts-modal spts-modal-wide" onClick={e=>e.stopPropagation()}>
   <h3 className="spts-modal-title">Request portfolio</h3>
   <form className="spts-adform" onSubmit={submit}>
    <label>Full name<input required value={name} onChange={e=>setName(e.target.value)} autoComplete="name" disabled={sending}/></label>
    <label>Mobile<input required type="tel" inputMode="tel" placeholder="+234…" value={mobile} onChange={e=>setMobile(e.target.value)} autoComplete="tel" disabled={sending}/></label>
    <label>Description
     <textarea required maxLength={AD_MAX_DESC} placeholder="What should your portfolio show, and how should it look? e.g. my design work, dark and minimal, with a contact button." value={desc} onChange={e=>setDesc(e.target.value)} disabled={sending}/>
    </label>
    <div className="spts-adform-row">
     <label>Duration
      <select value={days} onChange={e=>setDays(Number(e.target.value))} disabled={sending}>
       {AD_DURATIONS.map(d=><option key={d.days} value={d.days}>{d.label}</option>)}
      </select>
     </label>
     <label>Start date<input required type="date" min={today} value={start} onChange={e=>setStart(e.target.value)} disabled={sending}/></label>
    </div>
    <label>End date (automatic)<input readOnly tabIndex={-1} className="spts-adform-readonly" value={end?prettyDate(end):""} placeholder="Pick a start date"/></label>
    {err&&<p className="spts-error" role="alert"><ErrText text={err}/></p>}
    <div className="spts-modal-actions">
     <button type="button" className="spts-ghost" onClick={onClose} disabled={sending}>Cancel</button>
     <SpinnerButton type="submit" busy={sending} busyLabel="Sending…">Send request</SpinnerButton>
    </div>
   </form>
  </div>
 </div>;
}

/* Premium: the owner adds their own portfolio. Uploads one .html file (under 0.5 MB); it is checked and
 * saved to profiles/{username}/ad/code as { html }, the same place and shape as a portfolio added by hand. */
function PortfolioUpload({profile}:{profile:any}){
 const toast=useToast();const confirm=useConfirm();
 const [ad,setAd]=useState<AdDoc|null>(()=>readAdCache(profile.username));
 const [file,setFile]=useState<File|null>(null),[fileErr,setFileErr]=useState(""),[err,setErr]=useState("");
 const [busy,setBusy]=useState(false),[removing,setRemoving]=useState(false);
 const [days,setDays]=useState(7);
 const inputRef=useRef<HTMLInputElement>(null);
 const adRef=doc(profileDb,"profiles",profile.username,"ad","code");

 useEffect(()=>{
  let alive=true;
  fetchAd(profile.username).then(a=>{ if(!alive)return; writeAdCache(profile.username,a); setAd(a); }).catch(()=>{});
  return ()=>{alive=false};
 },[profile.username]);

 const phase=ad?adPhase(ad,todayLocal()):null;
 const badge=phase==="live"?"Live":phase==="scheduled"?"Scheduled":phase==="expired"?"Expired":"";
 // Once a portfolio with a set duration goes live it can't be removed until that duration ends.
 const locked=phase==="live"&&!!ad?.endDate;

 function pick(e:React.ChangeEvent<HTMLInputElement>){
  const f=e.target.files?.[0]||null;
  setErr("");setFile(f);setFileErr(f?checkPortfolioFile(f):"");
 }
 async function upload(e:React.FormEvent){
  e.preventDefault();
  if(!file)return;
  setErr("");setBusy(true);
  try{
   const html=await readPortfolioFile(file);
   // Same doc and shape as a portfolio added by hand: { html, startDate, endDate }.
   // While a duration is running, replacing the page keeps its dates; otherwise a new run starts today.
   const data:Record<string,string>={html};
   if(locked&&ad){
    if(ad.startDate)data.startDate=ad.startDate;
    if(ad.endDate)data.endDate=ad.endDate;
   }else{
    const t=todayLocal();
    data.startDate=t;data.endDate=endDateFor(t,days);
   }
   await setDoc(adRef,data);
   const next=parseAd(data)!;
   writeAdCache(profile.username,next);setAd(next);
   setFile(null);setFileErr("");if(inputRef.current)inputRef.current.value="";
   toast("success",locked?"Portfolio updated.":`Portfolio is live until ${prettyDate(data.endDate)}.`);
  }catch(x:any){ setErr(fail(toast,x,"Unable to publish portfolio")); }
  finally{ setBusy(false); }
 }
 async function remove(){
  if(locked)return;
  const ok=await confirm({
   title:"Remove your portfolio?",
   body:<p className="spts-muted">This deletes the page you uploaded. Your profile and posts are not affected, and you can upload again any time.</p>,
   confirmLabel:"Remove portfolio",danger:true,
  });
  if(!ok)return;
  setRemoving(true);setErr("");
  try{ await deleteDoc(adRef); writeAdCache(profile.username,null); setAd(null); toast("success","Portfolio removed."); }
  catch(x:any){ setErr(fail(toast,x,"Unable to remove portfolio")); }
  finally{ setRemoving(false); }
 }

 return <section className="spts-card">
  <div className="spts-card-head"><h2>Portfolio</h2>{badge&&phase?<Hint k={BADGE_HINT[phase]} plain className="spts-badge">{badge}</Hint>:null}</div>
  <p className="spts-muted">
   {!ad&&<>Upload an HTML file and choose how long it stays live (1 week or more). No request needed.</>}
   {phase==="live"&&locked&&ad?.endDate&&<>Your portfolio is live until {prettyDate(ad.endDate)} and can't be removed before then. Uploading again replaces the page and keeps the same dates.</>}
   {phase==="live"&&!locked&&<>Your portfolio is live. Uploading again replaces it.</>}
   {phase==="scheduled"&&<>Your portfolio goes live {ad?.startDate?`on ${prettyDate(ad.startDate)}`:"soon"}. Uploading again replaces it and publishes right away.</>}
   {phase==="expired"&&<>Your last portfolio expired{ad?.endDate?` on ${prettyDate(ad.endDate)}`:""}. Upload again to publish for a new duration.</>}
  </p>
  <form onSubmit={upload}>
   <label className="spts-fileupload-row">HTML file, under 0.5 MB
    <input ref={inputRef} type="file" accept=".html,.htm,text/html" onChange={pick} disabled={busy||removing}/>
   </label>
   {!locked&&<label>Duration
    <select value={days} onChange={e=>setDays(Number(e.target.value))} disabled={busy||removing}>
     {PORTFOLIO_DURATIONS.map(d=><option key={d.days} value={d.days}>{d.label}</option>)}
    </select>
   </label>}
   {fileErr&&<div className="spts-error-box" role="alert"><span className="spts-error-icon" aria-hidden="true">!</span><span>{fileErr}</span></div>}
   {err&&<div className="spts-error-box" role="alert"><span className="spts-error-icon" aria-hidden="true">!</span><span><ErrText text={err}/></span></div>}
   <div className="spts-ad-actions">
    <SpinnerButton type="submit" busy={busy} busyLabel="Publishing…" disabled={!file||!!fileErr||removing}>{ad?"Replace portfolio":"Upload portfolio"}</SpinnerButton>
    {ad&&<SpinnerButton className="spts-danger" busy={removing} busyLabel="Removing…" disabled={busy||locked} onClick={remove} title={locked&&ad.endDate?`Locked until ${prettyDate(ad.endDate)}`:undefined}>Remove</SpinnerButton>}
    {phase==="live"&&<a className="spts-ad-link spts-ghost" href={`/profile/${profile.username}/ad`}>View portfolio</a>}
   </div>
  </form>
 </section>;
}

/* Dashboard card. Basic profiles request a portfolio; Premium profiles upload their own. */
function AdRequest({user,profile}:{user:User;profile:any}){
 return profile.premium?<PortfolioUpload profile={profile}/>:<AdRequestCard user={user} profile={profile}/>;
}

const BADGE_HINT:Record<string,HintKey>={live:"adLive",scheduled:"adScheduled",waiting:"adWaiting",expired:"adExpired"};
// One button, plus the portfolio's current state.
function AdRequestCard({user,profile}:{user:User;profile:any}){
 const [open,setOpen]=useState(false),[bump,setBump]=useState(0);
 const status=useAdStatus(user,profile.username,bump);
 const phase=status?.phase;
 const blocked=phase==="live"||phase==="scheduled";
 const badge=phase==="live"?"Live":phase==="scheduled"?"Scheduled":phase==="waiting"?"Waiting":phase==="expired"?"Expired":"";
 const range=(s?:string,e?:string)=>s&&e?`${prettyDate(s)} – ${prettyDate(e)}`:e?`until ${prettyDate(e)}`:s?`from ${prettyDate(s)}`:"";

 return <section className="spts-card">
  <div className="spts-card-head"><h2>Portfolio</h2>{badge&&phase&&BADGE_HINT[phase]?<Hint k={BADGE_HINT[phase]} plain className="spts-badge">{badge}</Hint>:null}</div>
  <p className="spts-muted">
   {phase==="live"&&<>Your portfolio is live{status?.endDate?` until ${prettyDate(status.endDate)}`:""}. You can request again once it expires.</>}
   {phase==="scheduled"&&<>Your portfolio is ready and goes live {status?.startDate?`on ${prettyDate(status.startDate)}`:"soon"}.</>}
   {phase==="waiting"&&<>Request sent for {range(status?.startDate,status?.endDate)}. We're preparing your portfolio — it goes live once it's ready. You can send another request if something changed.</>}
   {phase==="expired"&&<>Your last portfolio expired{status?.endDate?` on ${prettyDate(status.endDate)}`:""}. Request another run any time.</>}
   {(phase==="none"||!phase)&&<>Get a portfolio at <a href={`/profile/${profile.username}/ad`}>/profile/{profile.username}/ad</a>.</>}
  </p>
  <div className="spts-ad-actions">
   <button type="button" disabled={blocked} onClick={()=>setOpen(true)}>Request portfolio</button>
   {phase==="live"&&<a className="spts-ad-link spts-ghost" href={`/profile/${profile.username}/ad`}>See portfolio</a>}
  </div>
  <p className="spts-muted">Premium members upload their own portfolio.</p>
  {open&&<AdRequestModal user={user} profile={profile} onClose={()=>setOpen(false)} onSent={()=>{setOpen(false);setBump(b=>b+1);}}/>}
 </section>;
}

// Shown on the public portfolio page when there is no live portfolio.
function AdRequestCta({user,authLoading}:{user:User|null;authLoading:boolean}){
 const {loading,profile}=useOwnProfile(user);
 const [open,setOpen]=useState(false),[sent,setSent]=useState(false);
 if(sent)return <p className="spts-muted">Request sent — we'll be in touch soon.</p>;
 if(authLoading||(user&&loading))return <button type="button" disabled>Request portfolio</button>;
 if(!user)return <>
  <a className="spts-ad-link spts-ad-cta" href="/profiles">Request portfolio</a>
  <p className="spts-muted">Create a profile first, then request your portfolio.</p>
 </>;
 if(!profile)return <>
  <a className="spts-ad-link spts-ad-cta" href="/profiles">Create your profile</a>
  <p className="spts-muted">You need a profile first.</p>
 </>;
 if(profile.premium)return <>
  <a className="spts-ad-link spts-ad-cta" href="/">Add your portfolio</a>
  <p className="spts-muted">Premium: upload your own HTML file from your dashboard.</p>
 </>;
 return <>
  <button type="button" onClick={()=>setOpen(true)}>Request portfolio</button>
  {open&&<AdRequestModal user={user} profile={profile} onClose={()=>setOpen(false)} onSent={()=>{setOpen(false);setSent(true);}}/>}
 </>;
}

// Public portfolio page (route + Firestore names still say "ad"). Runs the html string in a sandboxed iframe
// (no allow-same-origin), so the code can't reach this app's auth session, storage or DOM. Same for every profile.
// Premium portfolios also get an optional "Open in new tab" button (see openLocally).
// A cached copy renders on the very first paint (no loading screen); Firestore then refreshes it silently.
function AdView({username,user,authLoading}:{username:string;user:User|null;authLoading:boolean}){
 const uname=normalizeUsername(username);
 const [ad,setAd]=useState<AdDoc|null>(()=>typeof window!=="undefined"?readAdCache(uname):null);
 const [premium,setPremium]=useState<boolean|null>(()=>typeof window!=="undefined"?readPremiumCache(uname):null);
 const [settled,setSettled]=useState(false),[failed,setFailed]=useState(false),[failedText,setFailedText]=useState(ACCESS_GENERIC),[tries,setTries]=useState(0);
 const [copied,setCopied]=useState(false);
 const toast=useToast();const confirm=useConfirm();
 async function copyLink(){
  try{
   await navigator.clipboard.writeText(`${location.origin}/profile/${uname}/ad`);
   setCopied(true);setTimeout(()=>setCopied(false),2000);
  }catch{ toast("error","Couldn't copy the link."); }
 }

 useEffect(()=>{
  let alive=true;
  setFailed(false);
  Promise.all([fetchAd(uname),fetchPremium(uname).catch(()=>false)]).then(([a,pr])=>{
   if(!alive)return;
   writeAdCache(uname,a);writePremiumCache(uname,pr);
   setAd(prev=>sameAd(prev,a)?prev:a); // unchanged ad => no iframe reload
   setPremium(pr);
   setSettled(true);
  }).catch((e:any)=>{
   if(!alive)return;
   setFailedText(accessText(e,ACCESS_GENERIC)===ACCESS_PERSIST?ACCESS_PERSIST:ACCESS_GENERIC);
   setFailed(true);setSettled(true); // permission denied, offline, etc.
  });
  return ()=>{alive=false};
 },[uname,tries]);

 const live=!!ad&&adPhase(ad,todayLocal())==="live";

 // Optional, Premium portfolios only, and only when the visitor taps it. The saved html is turned into a
 // local blob: page on this device and opened in a new tab, outside the sandbox. That page shares this
 // site's origin, so the visitor is asked to confirm first.
 async function openLocally(){
  if(!ad)return;
  const ok=await confirm({
   title:"Open outside the sandbox?",
   body:<p className="spts-muted">This opens the portfolio in a new tab on your device without the sandbox, so its code runs with the same access as this site. Only continue if you trust @{uname}.</p>,
   confirmLabel:"Open in new tab",
  });
  if(!ok)return;
  try{
   const url=URL.createObjectURL(new Blob([ad.html],{type:"text/html;charset=utf-8"}));
   window.open(url,"_blank","noopener");
   setTimeout(()=>URL.revokeObjectURL(url),10*60*1000);
  }catch{ toast("error","Couldn't open the portfolio in a new tab."); }
 }

 return <main className="spts-ad">
  <header className="spts-ad-bar">
   <a className="spts-ghost spts-link-btn" href={`/profile/${uname}`}><Ico d={ICON.back}/> @{uname}</a>
   <div className="spts-ad-bar-actions">
    <button type="button" className="spts-ghost" onClick={copyLink}>{copied?<><Ico d={ICON.check}/> Copied</>:"Copy link"}</button>
    {live&&premium===true&&<button type="button" className="spts-ghost" onClick={openLocally}>Open in new tab</button>}
   </div>
  </header>
  {live&&<iframe
   className="spts-ad-frame"
   title={`Portfolio by @${uname}`}
   srcDoc={ad!.html}
   sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
   referrerPolicy="no-referrer"
  />}
  {!live&&!settled&&<div className="spts-ad-frame spts-ad-blank"/>}
  {!live&&settled&&!failed&&<div className="spts-public-status">
   <h1>Portfolio not found</h1>
   <p className="spts-muted">@{uname} has no portfolio live right now.</p>
   <AdRequestCta user={user} authLoading={authLoading}/>
  </div>}
  {!live&&settled&&failed&&<div className="spts-public-status">
   <h1>Couldn't load the portfolio</h1>
   <p className="spts-muted"><ErrText text={failedText}/></p>
   <button type="button" onClick={()=>{setSettled(false);setTries(t=>t+1);}}>Try again</button>
  </div>}
 </main>;
}

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */
export default function ProfileNetwork({username,view}:{username?:string;view?:"ad"|"portfolio"}){
 const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true);
 useEffect(()=>onAuthStateChanged(profileAuth,u=>{setUser(u);setLoading(false);runTTLSweep();}),[]); // sweep once auth is known
 useEffect(()=>{
  const id=setInterval(runTTLSweep,5*60*1000);
  return ()=>clearInterval(id);
 },[]);
 // /profile/{username}/ad — pass view="ad" from your router, or let the path match below handle it.
 const adMatch=/^\/profile\/([^/]+)\/(?:ad|portfolio)\/?$/.exec(typeof location!=="undefined"?location.pathname:"");
 const adUser=(view==="ad"||view==="portfolio")?username:adMatch?decodeURIComponent(adMatch[1]):undefined;
 // The ad page never waits for auth: the ad paints straight away, auth only matters for the "Request portfolio" button.
 if(adUser)return <ToastHost><ConfirmHost><AdView key={adUser} username={adUser} user={user} authLoading={loading}/></ConfirmHost></ToastHost>;
 if(loading)return <main className="spts-page">Loading…</main>;
 return <ToastHost><ConfirmHost><ActiveVideoHost>
  {username==="upgradesuccessConfirm"?<UpgradeSuccess user={user}/>
   :username?<PublicProfile username={username} user={user}/>
   :user?<Dashboard user={user}/>
   :<main className="spts-page"><Auth done={()=>{}}/></main>}
 </ActiveVideoHost></ConfirmHost></ToastHost>;
  }
