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
// The dashboard is the page this component renders when there is no username in the URL (same page as
// "Get your own profile"). Change DASHBOARD_PATH if your router mounts it somewhere else.
const DASHBOARD_PATH="/profiles";
const DASHBOARD_TOUR_URL=`${DASHBOARD_PATH}?tour=1`; // opens the tour on arrival

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
 *    its profile in Firestore (checkAccount). If it isn't found there, the flag notice shows,
 *    telling the user they've been restricted for a Terms of Service violation (with a link
 *    to reread it) and pointing them to Contact support for review — the only two suggestions
 *    given. The dashboard overview is held back until this check finishes, so it never flashes
 *    for a flagged account.
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

const flaggedError=(restrictionCount:number)=>Object.assign(new Error("account-flagged"),{code:"spts/account-flagged",restrictionCount});
const isFlagged=(x:any)=>x?.code==="spts/account-flagged";
type Standing={state:"new"}|{state:"ok";username:string;profile:any};
/* users/{uid} -> username -> profiles/{username}, whose uid must equal the signed-in uid.
 * No users/{uid} at all = a new sign-up that hasn't created a profile yet (normal, not flagged).
 *
 * Restricting an account is still a manual, by-hand action in the Firestore console — breaking
 * the uid link on profiles/{username} (or deleting the doc outright, or setting `locked:true` on
 * it, for a repeat offender whose public profile should disappear too — see PublicProfile below).
 * Everything past that single action is automatic, client-side and realtime, on users/{uid}:
 *   restricted: mirrors whether the account is currently restricted.
 *   restrictionCount: a permanent count of how many times it ever has been (2+ = repeat offender);
 *     the client bumps this itself the instant it detects a fresh restriction — no console step.
 *   resolvedNotice: the client sets this true the instant it detects a restriction being lifted,
 *     so the owner's dashboard shows a one-time "reviewed, restrictions removed" notice next time
 *     it's open, then clears the flag itself once shown.
 * watchAccountStanding (used by the dashboard) keeps all of this live via onSnapshot, so a
 * restriction or its resolution shows up immediately, no reload needed. checkAccount below stays
 * a plain one-shot read for the upgrade flow, which only ever needs a point-in-time check.
 */
async function checkAccount(user:User):Promise<Standing>{
 const us=await getDoc(doc(profileDb,"users",user.uid));
 if(!us.exists())return {state:"new"};
 const ud=us.data();const uname:string=ud.username;
 const pf=uname?await getDoc(doc(profileDb,"profiles",uname)):null;
 if(!pf||!pf.exists()||pf.data().uid!==user.uid||pf.data().locked)throw flaggedError(Number(ud.restrictionCount)||1);
 return {state:"ok",username:uname,profile:pf.data()};
}
/* Realtime version of the same standing check, self-healing the users/{uid} restriction
 * bookkeeping as it goes. Calls onChange with the current standing every time either doc updates;
 * returns an unsubscribe function. */
function watchAccountStanding(user:User,onChange:(st:Standing|{state:"flagged";restrictionCount:number}|{state:"loading"})=>void){
 let profileUnsub:(()=>void)|null=null;
 const usersRef=doc(profileDb,"users",user.uid);
 const usersUnsub=onSnapshot(usersRef,us=>{
  profileUnsub?.();profileUnsub=null;
  if(!us.exists()){onChange({state:"new"});return;}
  const ud=us.data();const uname:string=ud.username;
  if(!uname){onChange({state:"new"});return;}
  profileUnsub=onSnapshot(doc(profileDb,"profiles",uname),pf=>{
   const flaggedNow=!pf.exists()||pf.data()!.uid!==user.uid||!!pf.data()!.locked;
   if(flaggedNow&&!ud.restricted) // fresh restriction: record it, automatically, right now
    setDoc(usersRef,{restricted:true,restrictionCount:increment(1),restrictedAt:serverTimestamp()},{merge:true}).catch(()=>{});
   else if(!flaggedNow&&ud.restricted) // just resolved: record it and queue the one-time notice
    setDoc(usersRef,{restricted:false,resolvedNotice:true,resolvedAt:serverTimestamp()},{merge:true}).catch(()=>{});
   if(flaggedNow)onChange({state:"flagged",restrictionCount:Number(ud.restrictionCount)||1});
   else onChange({state:"ok",username:uname,profile:{...pf.data()!,resolvedNotice:!!ud.resolvedNotice}});
  },()=>onChange({state:"new"}));
 },()=>onChange({state:"new"}));
 return ()=>{usersUnsub();profileUnsub?.();};
}
async function requireLinkedProfile(user:User):Promise<string>{
 const st=await checkAccount(user);
 if(st.state==="new")throw new Error("Create your public profile first, then upgrade.");
 return st.username;
}

// Edit these two lists to match what really is / isn't affected.
const FLAG_AFFECTED=["Editing or managing your profile","Posts, and messaging through public profile","Premium upgrade and some features"];
const FLAG_STILL_OK=["Logging in and out","Viewing other people's public profiles","Sending messages and comments on other profiles","Your public profile and portfolio"];
function AccountFlagNotice({uid,restrictionCount=1,showSupport=true}:{uid?:string;restrictionCount?:number;showSupport?:boolean}){
 const repeat=restrictionCount>=2;
 const [legalOpen,setLegalOpen]=useState(false);
 return <div className="spts-flag-notice" role="alert">
  {repeat
   ?<p>Your account has been restricted again for repeatedly violating our <button type="button" className="spts-legal-link" onClick={()=>setLegalOpen(true)}>Terms of Service</button>. At this stage nothing is accessible, including your public profile — visitors can't see it either.</p>
   :<><p>Your account has been restricted for violating our <button type="button" className="spts-legal-link" onClick={()=>setLegalOpen(true)}>Terms of Service</button>, and is pending review.</p>
     <div><span className="spts-flag-h">May not work</span><ul>{FLAG_AFFECTED.map(t=><li key={t}>{t}</li>)}</ul></div>
     <div><span className="spts-flag-h spts-flag-ok">Still available</span><ul>{FLAG_STILL_OK.map(t=><li key={t}>{t}</li>)}</ul></div></>}
  <p>Please re-read our <button type="button" className="spts-legal-link" onClick={()=>setLegalOpen(true)}>Terms of Service</button>{showSupport&&<>, then <a className="spts-link" href={supportUrl(`Hi, my account is showing as restricted and I'd like it reviewed.${uid?` Account ID: ${uid}`:""}`)} target="_blank" rel="noreferrer">contact support</a> for review</>}.</p>
  {legalOpen&&<LegalModal kind="terms" onClose={()=>setLegalOpen(false)}/>}
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
 caret:"M6 9l6 6 6-6",
 share:"M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13",
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
 premium:"Premium: gold profile theme, direct file uploads, portfolio download, and requesting a portfolio built for you.",
 live:"Your public profile is live and visible to anyone with your link.",
 like:"Likes are removed 24 hours after they're added, from the device that added them.",
 postCount:`Posts used out of the ${MAX_POSTS} allowed.`,
 inboxCount:"Conversations with visitors. Each visitor is one conversation.",
 upgrade:"Opens Paystack to pay for Premium, which unlocks the gold theme, file uploads, portfolio download and portfolio requests.",
 adLive:"Your portfolio page is visible to the public.",
 adScheduled:"Your portfolio is ready and goes live on its start date.",
 adWaiting:"Request received. We're preparing your portfolio.",
 adExpired:"This run has ended. You can request another.",
 // Plain words people tap thinking they do something
 dashTitle:"Dashboard: your private control panel. Only you can see it.",
 cardProfile:"Profile: your public details. Tap Manage profile to change them.",
 cardPosts:"Posts: photos and videos that show on your public profile.",
 cardInbox:"Inbox: anonymous messages from visitors. Only you can read and reply.",
 cardPortfolio:"Portfolio: an optional page for your work, linked from See portfolio on your profile.",
 portfolioOwn:"Upload your own portfolio page. Premium members can also request one built for them.",
 postsOwn:"Add photos and videos to your public profile.",
 cardOverview:"Overview: what is happening on your profile and what to do next. It hides while a card is open.",
 usernameOwn:"Your username is the last part of your public link. It can't be changed here; contact support if you need to.",
 lockedField:"This field is locked after setup. Contact support to change it.",
 handlePublic:"A username is unique to one profile and is part of this page's link.",
 namePublic:"Tap Message to write to them, or See posts to browse their work.",
 noPhoto:"This profile has no photo yet.",
 postsPublic:"Posts this person has shared on their profile.",
 shareOwn:"Writes a ready-to-send message with your profile link, copies it, and opens WhatsApp, email and more.",
 qrOwn:"Makes a QR code that opens your public profile. Download it as an image to print or post.",
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
// quiet: plain text with no underline or button styling; it only answers when tapped (for words people tap by mistake).
function Hint({k,children,className,plain,quiet}:{k:HintKey;children:React.ReactNode;className?:string;plain?:boolean;quiet?:boolean}){
 const {props,show}=useHint();
 if(quiet)return <span className={`spts-tip${className?" "+className:""}`} onClick={()=>show(k)}>{children}</span>;
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
 * Legal — Terms of Service and Privacy Notice, shown from the sign-up form.
 * Firestore: legal/resources  { terms: string, policies: string }
 * Any line that starts with a number (1. / 1.1 / 2) ) is a heading or sub-heading and shows bold.
 * The sign-up page is used signed out, so the rules must let anyone read (never write) this one document.
 * ------------------------------------------------------------------ */
type LegalKind="terms"|"policies";
const LEGAL_TITLES:Record<LegalKind,string>={terms:"Terms of Service",policies:"Privacy Notice"};
const LEGAL_NUMBERED=/^\d+(?:\.\d+)*[.)]?(?:\s|$)/;
let legalCache:{terms:string;policies:string}|null=null; // loaded once per visit
async function loadLegal():Promise<{terms:string;policies:string}>{
 if(legalCache)return legalCache;
 const s=await getDoc(doc(profileDb,"legal","resources"));
 const d:any=s.exists()?s.data():{};
 const out={terms:typeof d.terms==="string"?d.terms:"",policies:typeof d.policies==="string"?d.policies:""};
 if(s.exists())legalCache=out;
 return out;
}
function LegalText({text}:{text:string}){
 const lines=text.replace(/\\n/g,"\n").split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
 return <>{lines.map((l,i)=>LEGAL_NUMBERED.test(l)
  ?<p key={i} className="spts-legal-h"><b>{l}</b></p>
  :<p key={i}>{l}</p>)}</>;
}
function LegalModal({kind,onClose}:{kind:LegalKind;onClose:()=>void}){
 const [text,setText]=useState<string|null>(null),[err,setErr]=useState(""),[tries,setTries]=useState(0);
 useEffect(()=>{
  let live=true;setText(null);setErr("");
  loadLegal().then(d=>{ if(live)setText(d[kind]); },e=>{ if(live)setErr(accessText(e,"Couldn't load this. Try again.")); });
  return ()=>{live=false;};
 },[kind,tries]);
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{ if(e.key==="Escape")onClose(); };
  window.addEventListener("keydown",onKey);
  return ()=>window.removeEventListener("keydown",onKey);
 },[onClose]);
 const ready=text!==null&&text.trim()!=="";
 return <div className="spts-modal-backdrop" role="dialog" aria-modal="true" aria-label={LEGAL_TITLES[kind]} onClick={onClose}>
  <div className="spts-modal spts-modal-wide" onClick={e=>e.stopPropagation()}>
   <h3 className="spts-modal-title">{LEGAL_TITLES[kind]}</h3>
   <div className="spts-modal-body spts-legal-body">
    {err?<p className="spts-legal-err"><ErrText text={err}/></p>
     :text===null?<p className="spts-muted">Loading…</p>
     :ready?<LegalText text={text as string}/>
     :<p className="spts-muted">This isn't available right now. Please try again later.</p>}
   </div>
   <div className="spts-modal-actions">
    {ready
     ?<button type="button" autoFocus onClick={onClose}>Agree</button>
     :<>
      {(err||text!==null)&&<button type="button" onClick={()=>setTries(n=>n+1)}>Try again</button>}
      <button type="button" className="spts-ghost" onClick={onClose}>Close</button>
     </>}
   </div>
  </div>
 </div>;
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
function Auth({done}:{done:()=>void}){
 const [signup,setSignup]=useState(true),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[err,setErr]=useState(""),[busy,setBusy]=useState(false);
 const [resetting,setResetting]=useState(false),[legal,setLegal]=useState<LegalKind|null>(null);
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
 {signup&&<p className="spts-legal-note">By creating an account, you agree to our <button type="button" className="spts-legal-link" onClick={()=>setLegal("terms")}>Terms of Service</button> and <button type="button" className="spts-legal-link" onClick={()=>setLegal("policies")}>Privacy Notice</button>.</p>}
 </form>{err&&<p className="spts-error"><ErrText text={err}/></p>}
 {!signup&&<p><button type="button" className="spts-link" onClick={reset} disabled={busy||resetting}>{resetting?"Sending link…":"Reset password"}</button></p>}
 <button className="spts-link" onClick={()=>setSignup(!signup)} disabled={busy||resetting}>{signup?"Already registered? Log in":"Create an account"}</button>
 {legal&&<LegalModal kind={legal} onClose={()=>setLegal(null)}/>}</section>
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
  <div className="spts-card-head"><h2><Hint quiet k="cardInbox">Inbox</Hint></h2><Hint k="inboxCount" plain className="spts-badge">{conversations.length}</Hint></div>
  <AutoDeleteNotice text="Messages and replies are removed 24h after they're sent."/>
  {loading&&<p className="spts-muted">Loading messages…</p>}
  {err&&<p className="spts-error">Couldn't load messages: <ErrText text={err}/></p>}
  {!loading&&!err&&conversations.length===0&&<p className="spts-muted">No messages yet. Anyone who visits your public profile can send you one.</p>}
  {conversations.map(c=><ConversationThread key={c.id} conversationId={c.id} visitorId={c.visitorId||c.id}/>)}
 </section>;
}

/* ------------------------------------------------------------------ *
 * Help: the dashboard tour, and the "Help?" popup on public profiles.
 * ------------------------------------------------------------------ */
type TourStep={title:string;body:React.ReactNode;action?:{label:string;run?:()=>void;href?:string;external?:boolean}};

// Step-by-step tour. Skip closes it at any time; reopen from "Help?" on the dashboard.
function Tour({steps,onClose}:{steps:TourStep[];onClose:()=>void}){
 const [i,setI]=useState(0);
 const step=steps[i],last=i===steps.length-1;
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{ if(e.key==="Escape")onClose(); };
  window.addEventListener("keydown",onKey);
  return ()=>window.removeEventListener("keydown",onKey);
 },[onClose]);
 const act=step.action;
 return <div className="spts-modal-backdrop" role="dialog" aria-modal="true" aria-label="Dashboard tour">
  <div className="spts-modal spts-modal-wide spts-tour">
   <div className="spts-tour-top">
    <span className="spts-tour-count">Step {i+1} of {steps.length}</span>
    <button type="button" className="spts-ghost spts-tour-close" aria-label="Skip tour" title="Skip tour" onClick={onClose}><Ico d={ICON.close}/></button>
   </div>
   <h3 className="spts-modal-title">{step.title}</h3>
   <div className="spts-modal-body">{step.body}</div>
   {act&&(act.href
    ?<a className="spts-ghost spts-link-btn spts-tour-action" href={act.href} {...(act.external?{target:"_blank",rel:"noreferrer"}:{})}>{act.label}</a>
    :<button type="button" className="spts-ghost spts-tour-action" onClick={()=>{onClose();act.run?.();}}>{act.label}</button>)}
   <div className="spts-tour-dots" aria-hidden="true">{steps.map((_,k)=><span key={k} className={k===i?"on":""}/>)}</div>
   <div className="spts-modal-actions">
    <button type="button" className="spts-ghost" onClick={()=>setI(n=>n-1)} disabled={i===0}>Back</button>
    {last
     ?<button type="button" autoFocus onClick={onClose}>Done</button>
     :<button type="button" autoFocus onClick={()=>setI(n=>n+1)}>Next</button>}
   </div>
  </div>
 </div>;
}

// What a new owner is usually unaware of, in the order they meet it. Wording follows the dashboard as it is.
function dashboardTourSteps(o:{profile:any|null;premium:boolean;showProfile:()=>void;showInbox:()=>void;showPortfolio:()=>void;showPosts:()=>void}):TourStep[]{
 const {profile,premium}=o;
 const steps:TourStep[]=[
  {title:"Welcome to your dashboard",body:<p>A quick tour of where everything is. When no card is open, the <b>Overview</b> shows new messages and suggestions. Skip any time, and reopen this tour from <b>Settings</b>, then <b>Help?</b>.</p>},
  profile
   ?{title:"Edit your profile",body:<p>Tap <b>Manage profile</b>, then <b>Edit</b>. After setup you can change your bio and fill any optional field you left empty. Your username, display name and filled fields are locked; use contact support to change those.</p>,action:{label:"Show me",run:o.showProfile}}
   :{title:"Create your profile",body:<p>Fill in a username and display name, then tap <b>Create profile</b>. Your username becomes your public link and can't be changed later.</p>,action:{label:"Show me",run:o.showProfile}},
  {title:"Put links in your bio",body:<p>Links, emails and phone numbers in your bio become tappable on your public profile. Share your GitHub, project pages or any URL there. A bio can be up to 1000 characters; visitors see the first 500, then <b>See more</b>.</p>},
 ];
 if(profile)steps.push({
  title:"See your public profile",
  body:<p>Under <b>Manage profile</b>, tap <b>View public profile</b> to see the page visitors get at <b>/profile/{profile.username}</b>. Visitors can tap your photo to view it full screen, and <b>Share profile</b> copies your link.</p>,
  action:{label:"Open my public profile",href:`/profile/${profile.username}`},
 });
 if(profile)steps.push({
  title:"Share your profile",
  body:<p>Tap <b>Share profile</b>, type the person's name, and the message is written for you and copied. Then send it through WhatsApp, Telegram, Facebook, email or any other app on your device.</p>,
 });
 if(profile)steps.push({
  title:"QR code",
  body:<p>Tap <b>QR code</b> to get a scannable image of your profile link. Download it as a PNG to print on a card or post online. It contains only your profile link.</p>,
 });
 steps.push(
  {title:"Contact buttons",body:<p>The website, email and phone you add show as <b>Website</b>, <b>Email</b> and <b>Phone</b> buttons on your public profile. You can fill any you left empty from <b>Edit</b>.</p>},
  {title:"Add posts",body:<p>Tap <b>Manage posts</b>. Posts appear on your public profile. Paste a photo or video link{premium?", or upload a file":" (Premium members can upload files)"}, add an optional caption, then tap <b>Add post</b>. You can keep up to {MAX_POSTS}. Manage or delete posts from your public profile.</p>,action:{label:"Show me",run:o.showPosts}},
  {title:"Likes and comments",body:<p>Signed-in visitors can like and comment on your posts. Comments can be up to {COMMENT_MAX} characters.</p>},
  {title:"Your inbox",body:<p>Tap <b>Go to inbox</b> to read messages from visitors, up to {MSG_MAX} characters each. They're anonymous: you see a visitor ID, not a name. Reply in the thread, or use <b>Delete visitor</b> to remove someone with all their messages.</p>,action:{label:"Show me",run:o.showInbox}},
  {title:"Portfolio",body:<p>Tap <b>Manage portfolio</b>, then upload your own HTML file (under 0.5 MB) and pick a duration of at least 1 week. While it's live it can't be removed. Visitors reach it from <b>See portfolio</b> on your profile.{premium?<> As a Premium member you can switch to <b>Request one</b> to have our team build it for you, and let visitors save yours as an HTML file with <b>Settings</b>, then <b>Portfolio download</b>.</>:null}</p>,action:{label:"Show me",run:o.showPortfolio}},
  {title:premium?"Your Premium features":"What Premium adds",body:premium
   ?<p>You have the gold theme on your public profile, direct photo and video uploads for posts, portfolio requests, and the portfolio download switch.</p>
   :<p>Premium gives you a gold theme on your public profile, direct photo and video uploads for posts, portfolio requests (our team builds one for you), and a switch that lets visitors download your portfolio. Find <b>Upgrade to Premium</b> in the Profile card.</p>,
   ...(premium?{}:{action:{label:"Show me",run:o.showProfile}})},
  {title:"Auto delete",body:<p>Posts, comments, likes, messages and replies are removed 24 hours after they're created. It runs from the device that created them, so that device needs to be online with its browser data kept. Tap or hover any dotted word for a quick explanation.</p>},
  {title:"Settings",body:<p>Top right, <b>Settings</b> holds <b>Account</b> (where you can delete your profile, or be sent to support to do it), <b>Help?</b> (reopens this tour) and <b>Sign out</b>.</p>},
  {title:"Need a hand?",body:<p>For anything this tour didn't cover, contact support.</p>,action:{label:"Contact support",href:supportUrl("Hi, I need help with my profile."),external:true}},
 );
 return steps;
}

/* ------------------------------------------------------------------ *
 * QR code (no library). Byte mode, error correction level M, versions 1-10 (up to 213 characters).
 * Follows the QR Code Model 2 spec; the layout mirrors the well-known public-domain style reference
 * implementations. qrMatrix() returns rows of dark(true)/light(false) modules.
 * ------------------------------------------------------------------ */
const QR_ECC_PER_BLOCK=[0,10,16,26,18,24,16,18,22,22,26];   // level M, index = version
const QR_NUM_BLOCKS=[0,1,1,1,2,2,4,4,4,5,5];                  // level M, index = version
const QR_MAX_VERSION=10;

function qrRawModules(ver:number):number{
 let r=(16*ver+128)*ver+64;
 if(ver>=2){ const n=Math.floor(ver/7)+2; r-=(25*n-10)*n-55; if(ver>=7)r-=36; }
 return r;
}
const qrDataCodewords=(ver:number)=>Math.floor(qrRawModules(ver)/8)-QR_ECC_PER_BLOCK[ver]*QR_NUM_BLOCKS[ver];

function rsMul(x:number,y:number):number{
 let z=0;
 for(let i=7;i>=0;i--){ z=(z<<1)^((z>>>7)*0x11D); z^=((y>>>i)&1)*x; }
 return z;
}
function rsDivisor(degree:number):number[]{
 const r=new Array<number>(degree).fill(0);
 r[degree-1]=1;
 let root=1;
 for(let i=0;i<degree;i++){
  for(let j=0;j<r.length;j++){ r[j]=rsMul(r[j],root); if(j+1<r.length)r[j]^=r[j+1]; }
  root=rsMul(root,2);
 }
 return r;
}
function rsRemainder(data:number[],div:number[]):number[]{
 const r=div.map(()=>0);
 for(const b of data){
  const f=b^(r.shift() as number);
  r.push(0);
  div.forEach((c,i)=>{ r[i]^=rsMul(c,f); });
 }
 return r;
}

function qrMatrix(text:string):boolean[][]{
 const bytes=Array.from(new TextEncoder().encode(text));
 // pick the smallest version that fits
 let ver=1;
 for(;;ver++){
  if(ver>QR_MAX_VERSION)throw new Error("Text too long for the QR code.");
  if(4+(ver<=9?8:16)+8*bytes.length<=qrDataCodewords(ver)*8)break;
 }
 // data bits: mode (byte), length, bytes, terminator, padding
 const bits:number[]=[];
 const put=(v:number,n:number)=>{ for(let i=n-1;i>=0;i--)bits.push((v>>>i)&1); };
 put(4,4);put(bytes.length,ver<=9?8:16);bytes.forEach(b=>put(b,8));
 const cap=qrDataCodewords(ver)*8;
 put(0,Math.min(4,cap-bits.length));
 put(0,(8-bits.length%8)%8);
 for(let pad=0xEC;bits.length<cap;pad^=0xEC^0x11)put(pad,8);
 const data:number[]=[];
 for(let i=0;i<bits.length;i+=8){ let v=0; for(let j=0;j<8;j++)v=(v<<1)|bits[i+j]; data.push(v); }

 // error correction + interleave
 const nb=QR_NUM_BLOCKS[ver],eccLen=QR_ECC_PER_BLOCK[ver];
 const raw=Math.floor(qrRawModules(ver)/8);
 const shortBlocks=nb-raw%nb,shortLen=Math.floor(raw/nb);
 const div=rsDivisor(eccLen);
 const blocks:number[][]=[];
 for(let i=0,k=0;i<nb;i++){
  const dat=data.slice(k,k+shortLen-eccLen+(i<shortBlocks?0:1));
  k+=dat.length;
  const ecc=rsRemainder(dat,div);
  if(i<shortBlocks)dat.push(0);
  blocks.push(dat.concat(ecc));
 }
 const all:number[]=[];
 for(let i=0;i<blocks[0].length;i++)blocks.forEach((b,j)=>{ if(i!==shortLen-eccLen||j>=shortBlocks)all.push(b[i]); });

 // function patterns
 const size=ver*4+17;
 const mod:boolean[][]=Array.from({length:size},()=>new Array<boolean>(size).fill(false));
 const fn:boolean[][]=Array.from({length:size},()=>new Array<boolean>(size).fill(false));
 const setFn=(x:number,y:number,dark:boolean)=>{ mod[y][x]=dark;fn[y][x]=true; };
 for(let i=0;i<size;i++){ setFn(6,i,i%2===0);setFn(i,6,i%2===0); }
 const finder=(cx:number,cy:number)=>{
  for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){
   const d=Math.max(Math.abs(dx),Math.abs(dy)),x=cx+dx,y=cy+dy;
   if(x>=0&&x<size&&y>=0&&y<size)setFn(x,y,d!==2&&d!==4);
  }
 };
 finder(3,3);finder(size-4,3);finder(3,size-4);
 if(ver>1){
  const n=Math.floor(ver/7)+2;
  const step=Math.ceil((ver*4+4)/(n*2-2))*2;
  const pos=[6];
  for(let p=size-7;pos.length<n;p-=step)pos.splice(1,0,p);
  for(let i=0;i<n;i++)for(let j=0;j<n;j++){
   if((i===0&&j===0)||(i===0&&j===n-1)||(i===n-1&&j===0))continue;
   for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)setFn(pos[i]+dx,pos[j]+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);
  }
 }
 const formatBits=(mask:number)=>{
  const d=(0<<3)|mask; // level M = 0
  let rem=d;
  for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);
  const bits=((d<<10)|rem)^0x5412;
  const b=(i:number)=>((bits>>>i)&1)!==0;
  for(let i=0;i<=5;i++)setFn(8,i,b(i));
  setFn(8,7,b(6));setFn(8,8,b(7));setFn(7,8,b(8));
  for(let i=9;i<15;i++)setFn(14-i,8,b(i));
  for(let i=0;i<8;i++)setFn(size-1-i,8,b(i));
  for(let i=8;i<15;i++)setFn(8,size-15+i,b(i));
  setFn(8,size-8,true);
 };
 formatBits(0);
 if(ver>=7){
  let rem=ver;
  for(let i=0;i<12;i++)rem=(rem<<1)^((rem>>>11)*0x1F25);
  const bits=(ver<<12)|rem;
  for(let i=0;i<18;i++){
   const bit=((bits>>>i)&1)!==0,a=size-11+i%3,b=Math.floor(i/3);
   setFn(a,b,bit);setFn(b,a,bit);
  }
 }

 // place codewords in the zigzag
 let bi=0;
 for(let right=size-1;right>=1;right-=2){
  if(right===6)right=5;
  for(let vert=0;vert<size;vert++)for(let j=0;j<2;j++){
   const x=right-j,upward=((right+1)&2)===0,y=upward?size-1-vert:vert;
   if(!fn[y][x]&&bi<all.length*8){ mod[y][x]=((all[bi>>>3]>>>(7-(bi&7)))&1)!==0; bi++; }
  }
 }

 // choose the mask with the lowest penalty
 const applyMask=(mask:number)=>{
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
   let inv:boolean;
   switch(mask){
    case 0:inv=(x+y)%2===0;break;
    case 1:inv=y%2===0;break;
    case 2:inv=x%3===0;break;
    case 3:inv=(x+y)%3===0;break;
    case 4:inv=(Math.floor(x/3)+Math.floor(y/2))%2===0;break;
    case 5:inv=x*y%2+x*y%3===0;break;
    case 6:inv=(x*y%2+x*y%3)%2===0;break;
    default:inv=((x+y)%2+x*y%3)%2===0;
   }
   if(!fn[y][x]&&inv)mod[y][x]=!mod[y][x];
  }
 };
 const penalty=():number=>{
  let p=0;
  const line=(get:(i:number)=>boolean)=>{
   let run=1;
   for(let i=1;i<size;i++){
    if(get(i)===get(i-1)){ run++; if(run===5)p+=3; else if(run>5)p++; } else run=1;
   }
   // finder-like 1:1:3:1:1 with a light border on either side
   for(let i=0;i+11<=size;i++){
    const a=[1,0,1,1,1,0,1,0,0,0,0],b=[0,0,0,0,1,0,1,1,1,0,1];
    let ma=true,mb=true;
    for(let k=0;k<11;k++){ const v=get(i+k)?1:0; if(v!==a[k])ma=false; if(v!==b[k])mb=false; }
    if(ma||mb)p+=40;
   }
  };
  for(let y=0;y<size;y++)line(i=>mod[y][i]);
  for(let x=0;x<size;x++)line(i=>mod[i][x]);
  for(let y=0;y<size-1;y++)for(let x=0;x<size-1;x++){
   const c=mod[y][x];
   if(c===mod[y][x+1]&&c===mod[y+1][x]&&c===mod[y+1][x+1])p+=3;
  }
  let dark=0;
  for(const row of mod)for(const c of row)if(c)dark++;
  p+=Math.floor(Math.abs(dark*20-size*size*10)/(size*size))*10; // balance of dark and light
  return p;
 };
 let best=0,bestP=Infinity;
 for(let m=0;m<8;m++){
  applyMask(m);formatBits(m);
  const p=penalty();
  if(p<bestP){best=m;bestP=p;}
  applyMask(m); // undo (XOR)
 }
 applyMask(best);formatBits(best);
 return mod;
}

// QR code for the public profile link (and nothing else), downloadable as profile-{username}.png.
function QrModal({profile,onClose}:{profile:any;onClose:()=>void}){
 const canvasRef=useRef<HTMLCanvasElement>(null);
 const [err,setErr]=useState("");
 const url=`${location.origin}/profile/${profile.username}`;
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{ if(e.key==="Escape")onClose(); };
  window.addEventListener("keydown",onKey);
  return ()=>window.removeEventListener("keydown",onKey);
 },[onClose]);
 useEffect(()=>{
  try{
   const m=qrMatrix(url),quiet=4,n=m.length+quiet*2;
   const scale=Math.max(8,Math.floor(1024/n)); // whole pixels per module keeps the edges sharp
   const c=canvasRef.current;if(!c)return;
   c.width=c.height=n*scale;
   const g=c.getContext("2d");if(!g)return;
   g.fillStyle="#fff";g.fillRect(0,0,c.width,c.height);
   g.fillStyle="#000";
   m.forEach((row,y)=>row.forEach((dark,x)=>{ if(dark)g.fillRect((x+quiet)*scale,(y+quiet)*scale,scale,scale); }));
   setErr("");
  }catch{ setErr("Couldn't make a QR code for this link."); }
 },[url]);
 function download(){
  canvasRef.current?.toBlob(b=>{
   if(!b)return;
   const href=URL.createObjectURL(b);
   const a=document.createElement("a");
   a.href=href;a.download=`profile-${profile.username}.png`;
   document.body.appendChild(a);a.click();a.remove();
   setTimeout(()=>URL.revokeObjectURL(href),1000);
  },"image/png");
 }
 return <div className="spts-modal-backdrop" role="dialog" aria-modal="true" aria-label="QR code" onClick={onClose}>
  <div className="spts-modal spts-modal-wide" onClick={e=>e.stopPropagation()}>
   <h3 className="spts-modal-title">Your QR code</h3>
   <div className="spts-modal-body">
    {err?<p className="spts-muted">{err}</p>:<canvas ref={canvasRef} className="spts-qr-canvas" role="img" aria-label={`QR code for ${url}`}/>}
    <p className="spts-muted spts-qr-link">Scanning it opens {url}</p>
   </div>
   <div className="spts-modal-actions">
    <button type="button" className="spts-ghost" onClick={onClose}>Close</button>
    {!err&&<button type="button" onClick={download}>Download PNG</button>}
   </div>
  </div>
 </div>;
}

// Share profile: asks who it's for, writes the message with their name and your link, copies it, and offers
// the apps on the device (native share sheet where available, plus direct WhatsApp / Telegram / Facebook / email).
function shareMessage(name:string,username:string){
 const who=name.trim()||"there";
 return `Hey ${who}, check out my profile page: ${location.origin}/profile/${username}\n\nMy links and projects are all in one spot. Tap "Message" if you want to send me something. It's anonymous.`;
}
function ShareProfileModal({profile,onClose}:{profile:any;onClose:()=>void}){
 const toast=useToast();
 const [name,setName]=useState("");
 const [msg,setMsg]=useState<string|null>(null); // set once the message has been made
 const canNativeShare=typeof navigator!=="undefined"&&typeof (navigator as any).share==="function";
 const url=`${location.origin}/profile/${profile.username}`;
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{ if(e.key==="Escape")onClose(); };
  window.addEventListener("keydown",onKey);
  return ()=>window.removeEventListener("keydown",onKey);
 },[onClose]);
 async function copy(text:string){
  try{ await navigator.clipboard.writeText(text); toast("success","Message copied. Paste it anywhere."); }
  catch{ toast("error","Couldn't copy. Select the message and copy it."); }
 }
 async function make(e:React.FormEvent){
  e.preventDefault();
  const m=shareMessage(name,profile.username);
  setMsg(m);
  await copy(m);
 }
 async function nativeShare(){
  try{ await (navigator as any).share({title:"My profile",text:msg}); }catch{/* closed without sharing */}
 }
 const enc=encodeURIComponent;
 return <div className="spts-modal-backdrop" role="dialog" aria-modal="true" aria-label="Share profile" onClick={onClose}>
  <div className="spts-modal spts-modal-wide" onClick={e=>e.stopPropagation()}>
   <h3 className="spts-modal-title">Share your profile</h3>
   {msg===null
    ?<form onSubmit={make}>
      <label>Who are you sharing it with?
       <input autoFocus maxLength={40} placeholder="Their name" value={name} onChange={e=>setName(e.target.value)}/>
      </label>
      <p className="spts-muted">We'll write the message with their name and your link, and copy it for you.</p>
      <div className="spts-modal-actions">
       <button type="button" className="spts-ghost" onClick={onClose}>Cancel</button>
       <button type="submit">Create message</button>
      </div>
     </form>
    :<>
      <div className="spts-share-preview">{msg}</div>
      <p className="spts-muted">Copied to your clipboard. Send it with:</p>
      <div className="spts-share-actions">
       {canNativeShare&&<button type="button" onClick={nativeShare}>More apps</button>}
       <a className="spts-ghost spts-link-btn" href={`https://wa.me/?text=${enc(msg)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>
       <a className="spts-ghost spts-link-btn" href={`https://t.me/share/url?url=${enc(url)}&text=${enc(msg)}`} target="_blank" rel="noopener noreferrer">Telegram</a>
       <a className="spts-ghost spts-link-btn" href={`https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`} target="_blank" rel="noopener noreferrer">Facebook</a>
       <a className="spts-ghost spts-link-btn" href={`mailto:?subject=${enc("My profile page")}&body=${enc(msg)}`}>Email</a>
       <button type="button" className="spts-ghost" onClick={()=>copy(msg)}>Copy again</button>
      </div>
      <p className="spts-muted">Facebook shares only the link, so paste the copied message in with it.</p>
      <div className="spts-modal-actions">
       <button type="button" className="spts-ghost" onClick={()=>setMsg(null)}>Change name</button>
       <button type="button" onClick={onClose}>Done</button>
      </div>
     </>}
  </div>
 </div>;
}

// Dashboard overview: shown when no card is open. Notifications say what is happening; suggestions say what to do next.
// Everything depends on the person: their inbox, portfolio, posts, profile details and plan.
type OvItem={key:string;text:React.ReactNode;action?:{label:string;run:()=>void};node?:React.ReactNode};
const plural=(n:number,one:string,many=one+"s")=>`${n} ${n===1?one:many}`;
function daysLeftInclusive(endIso:string):number{
 return Math.round((Date.parse(endIso+"T00:00:00Z")-Date.parse(todayLocal()+"T00:00:00Z"))/86400000)+1;
}
function joinList(a:string[]):string{ return a.length<=1?a.join(""):a.slice(0,-1).join(", ")+" and "+a[a.length-1]; }

type OverviewProps={user:User;profile:any|null;loadingProfile:boolean;posts:any[];premium:boolean;downloadOn:boolean;
 onOpenProfile:()=>void;onEditProfile:()=>void;onOpenInbox:()=>void;onOpenPortfolio:()=>void;onOpenPosts:()=>void;onShare:()=>void;onToggleDownload:()=>void};

function DashboardOverview(props:OverviewProps){
 if(props.loadingProfile)return null;
 if(!props.profile)return <section className="spts-card spts-overview">
  <div className="spts-card-head"><h2><Hint quiet k="cardOverview">Overview</Hint></h2></div>
  <ul className="spts-overview-list"><li className="spts-overview-item"><span>You don't have a public profile yet. Create one to get your own page.</span><button type="button" className="spts-ghost" onClick={props.onOpenProfile}>Create profile</button></li></ul>
 </section>;
 return <ProfileOverview {...props} profile={props.profile}/>;
}

function ProfileOverview({user,profile,posts,premium,downloadOn,onEditProfile,onOpenInbox,onOpenPortfolio,onOpenPosts,onShare,onToggleDownload}:OverviewProps&{profile:any}){
 const status=useAdStatus(user,profile.username,0);
 const [inbox,setInbox]=useState<{visitors:number;messages:number}|null|undefined>(undefined);
 useEffect(()=>onSnapshot(
  query(collection(profileDb,"conversations"),where("profileOwnerId","==",user.uid)),
  snap=>{ let m=0; snap.forEach(d=>{ m+=Number(d.data().messageCount)||0; }); setInbox({visitors:snap.size,messages:m}); },
  ()=>setInbox(null), // no access: just leave the inbox line out
 ),[user.uid]);

 const notes:OvItem[]=[],tips:OvItem[]=[];
 const phase=status?.phase;

 // Notifications
 if(inbox){
  notes.push(inbox.visitors>0
   ?{key:"inbox",text:`${plural(inbox.visitors,"visitor")} sent you ${plural(inbox.messages,"message")}.`,action:{label:"Open inbox",run:onOpenInbox}}
   :{key:"inbox",text:"No visitor messages yet."});
 }
 if(status){
  if(phase==="live"){
   const left=status.endDate?daysLeftInclusive(status.endDate):null;
   notes.push({key:"pf",text:left===null?"Your portfolio is live.":left<=1?"Your portfolio is live and expires today.":`Your portfolio is live and expires on ${prettyDate(status.endDate!)} (${left} days left).`,action:{label:"Manage portfolio",run:onOpenPortfolio}});
  }else if(phase==="scheduled"){
   notes.push({key:"pf",text:`Your portfolio goes live ${status.startDate?`on ${prettyDate(status.startDate)}`:"soon"}.`,action:{label:"Manage portfolio",run:onOpenPortfolio}});
  }else if(phase==="waiting"){
   notes.push({key:"pf",text:"Your portfolio request is being prepared. It goes live once it's ready."});
  }else if(phase==="expired"){
   notes.push({key:"pf",text:`Your portfolio expired${status.endDate?` on ${prettyDate(status.endDate)}`:""}.`,action:{label:"Upload again",run:onOpenPortfolio}});
  }else{
   tips.push({key:"pf",text:premium?"You don't have a live portfolio. Upload your own page, or request one built for you.":"You don't have a live portfolio. Upload your own page to showcase your work.",action:{label:"Manage portfolio",run:onOpenPortfolio}});
  }
  if(premium&&phase==="live"&&!downloadOn)notes.push({key:"dl",text:"Portfolio download is off, so visitors can't save your page.",action:{label:"Turn on",run:onToggleDownload}});
 }
 if(posts.length>0)notes.push({key:"posts",text:`${plural(posts.length,"post")} live on your public profile.`,action:{label:"Manage posts",run:onOpenPosts}});

 // Suggestions
 const missing:string[]=[];
 if(!profile.bio)missing.push("a bio");
 if(!profile.photoUrl)missing.push("a photo");
 if(!profile.websiteUrl)missing.push("a website");
 if(!profile.email)missing.push("an email");
 if(!profile.phone)missing.push("a phone number");
 if(missing.length)tips.unshift({key:"complete",text:`Complete your profile: add ${joinList(missing)}.`,action:{label:"Edit profile",run:onEditProfile}});
 else if(profile.bio&&detectContacts(profile.bio).urls.length===0)tips.unshift({key:"biolinks",text:"Add your GitHub or project links to your bio. They become tappable for visitors.",action:{label:"Edit profile",run:onEditProfile}});
 if(posts.length===0)tips.push({key:"post",text:"You haven't added a post yet. Posts give visitors something to see.",action:{label:"Manage posts",run:onOpenPosts}});
 if(!premium)tips.push({key:"upgrade",text:"Upgrade to Premium for the gold theme, direct file uploads, portfolio download and portfolio requests.",node:<UpgradeButton user={user}/>});
 tips.push({key:"share",text:"Share your profile in a message, or print your QR code.",action:{label:"Share profile",run:onShare}});

 const render=(it:OvItem)=><li key={it.key} className="spts-overview-item">
  <span>{it.text}</span>
  {it.action&&<button type="button" className="spts-ghost" onClick={it.action.run}>{it.action.label}</button>}
  {it.node}
 </li>;
 const shownTips=tips.slice(0,4),shownNotes=notes.slice(0,5);
 return <section className="spts-card spts-overview">
  <div className="spts-card-head"><h2><Hint quiet k="cardOverview">Overview</Hint></h2></div>
  {shownNotes.length>0&&<><h3 className="spts-overview-h">Notifications</h3><ul className="spts-overview-list">{shownNotes.map(render)}</ul></>}
  {shownTips.length>0&&<><h3 className="spts-overview-h">Suggestions</h3><ul className="spts-overview-list">{shownTips.map(render)}</ul></>}
 </section>;
}

// Settings dropdown on the dashboard: Account, Help?, Sign out.
function SettingsMenu({onAccount,onHelp,onSignOut,download}:{onAccount:()=>void;onHelp:()=>void;onSignOut:()=>void;download?:{on:boolean;busy:boolean;onToggle:()=>void}}){
 const [open,setOpen]=useState(false);
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(!open)return;
  const onDown=(e:PointerEvent)=>{ if(!ref.current?.contains(e.target as Node))setOpen(false); };
  const onKey=(e:KeyboardEvent)=>{ if(e.key==="Escape")setOpen(false); };
  document.addEventListener("pointerdown",onDown);
  document.addEventListener("keydown",onKey);
  return ()=>{document.removeEventListener("pointerdown",onDown);document.removeEventListener("keydown",onKey);};
 },[open]);
 const pick=(fn:()=>void)=>()=>{setOpen(false);fn();};
 return <div className="spts-settings" ref={ref}>
  <button type="button" className="spts-ghost" aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(o=>!o)}>Settings <Ico d={ICON.caret}/></button>
  {open&&<div className="spts-settings-menu" role="menu">
   <button type="button" role="menuitem" onClick={pick(onAccount)}>Account</button>
   {download&&<button type="button" role="menuitemcheckbox" aria-checked={download.on} disabled={download.busy} onClick={pick(download.onToggle)}>Portfolio download: {download.on?"On":"Off"}</button>}
   <button type="button" role="menuitem" onClick={pick(onHelp)}>Help?</button>
   <button type="button" role="menuitem" onClick={pick(onSignOut)}>Sign out</button>
  </div>}
 </div>;
}

// Account: who you're signed in as, and Delete profile. Deleting can't be done in the app, so after two failed
// attempts the person is sent to support instead.
const DELFAIL_KEY="spts_delfail_v1:";
function readDelFails(uid:string):number{ try{return parseInt(localStorage.getItem(DELFAIL_KEY+uid)||"0",10)||0;}catch{return 0;} }
function writeDelFails(uid:string,n:number){ try{ if(n>0)localStorage.setItem(DELFAIL_KEY+uid,String(n)); else localStorage.removeItem(DELFAIL_KEY+uid); }catch{} }

function AccountModal({user,profile,delFails,busy,onDelete,onClose}:{user:User;profile:any|null;delFails:number;busy:boolean;onDelete:()=>void;onClose:()=>void}){
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{ if(e.key==="Escape")onClose(); };
  window.addEventListener("keydown",onKey);
  return ()=>window.removeEventListener("keydown",onKey);
 },[onClose]);
 return <div className="spts-modal-backdrop" role="dialog" aria-modal="true" aria-label="Account" onClick={onClose}>
  <div className="spts-modal spts-modal-wide" onClick={e=>e.stopPropagation()}>
   <h3 className="spts-modal-title">Account</h3>
   <div className="spts-modal-body">
    <p><span className="spts-muted">Email</span><br/>{user.email||"Not available"}</p>
    <p><span className="spts-muted">Username</span><br/>{profile?`@${profile.username}`:"No profile yet"}</p>
    {profile&&<>
     <p><b>Delete profile</b></p>
     <p className="spts-muted">Removes your public profile page and the link between your account and its username. Your posts, likes, comments and inbox messages are not removed.</p>
     {delFails>=2&&<p className="spts-muted">This can't be done from the app right now. Support will delete it for you.</p>}
    </>}
   </div>
   <div className="spts-modal-actions">
    {profile&&(delFails>=2
     ?<a className="spts-danger spts-link-btn" href={supportUrl(`Hi, I'd like to delete my profile. Username: @${profile.username}`)} target="_blank" rel="noreferrer">Contact support to delete</a>
     :<SpinnerButton className="spts-danger" busy={busy} busyLabel="Deleting…" onClick={onDelete}>Delete profile</SpinnerButton>)}
    <button type="button" className="spts-ghost" onClick={onClose}>Close</button>
   </div>
  </div>
 </div>;
}

// "Help?" on a public profile, for everyone except the owner (who is sent to the dashboard tour instead).
function ProfileHelp({p,user,posts,onClose}:{p:any;user:User|null;posts:number;onClose:()=>void}){
 const {loading,profile}=useOwnProfile(user);
 useEffect(()=>{
  const onKey=(e:KeyboardEvent)=>{ if(e.key==="Escape")onClose(); };
  window.addEventListener("keydown",onKey);
  return ()=>window.removeEventListener("keydown",onKey);
 },[onClose]);
 const ad=readAdCache(p.username);
 const portfolioLive=!!ad&&adPhase(ad,todayLocal())==="live";
 const hasContact=!!(p.websiteUrl||p.email||p.phone);
 return <div className="spts-modal-backdrop" role="dialog" aria-modal="true" aria-label={`About @${p.username}`} onClick={onClose}>
  <div className="spts-modal spts-modal-wide" onClick={e=>e.stopPropagation()}>
   <h3 className="spts-modal-title">About @{p.username}</h3>
   <div className="spts-modal-body">
    <p>{p.displayName}'s public profile puts their work, contact details and an anonymous inbox behind one link. Here's what you can do:</p>
    <ul className="spts-modal-list">
     {posts>0&&<li><b>See posts</b> to browse their latest work. Signed-in visitors can like and comment.</li>}
     <li><b>Message</b> to write to them anonymously. Your name isn't shown, and their reply appears in the same chat.</li>
     {hasContact&&<li><b>Website</b>, <b>Email</b> or <b>Phone</b> to reach them directly.</li>}
     {portfolioLive&&<li><b>See portfolio</b> to view their portfolio page.</li>}
     <li><b>Share profile</b> to copy this link.</li>
    </ul>
    {!user&&<p>Log in to like and comment on posts. Messaging works without an account.</p>}
    {user&&!loading&&profile&&<p>You're signed in, and your own profile works the same way.</p>}
    {user&&!loading&&!profile&&<p>You're signed in but don't have a profile yet. Create one to get a page like this.</p>}
   </div>
   <div className="spts-modal-actions">
    {!user&&<a className="spts-ghost spts-link-btn" href="/profiles">Log in or create a profile</a>}
    {user&&!loading&&profile&&<a className="spts-ghost spts-link-btn" href={DASHBOARD_PATH}>Go to my dashboard</a>}
    {user&&!loading&&!profile&&<a className="spts-ghost spts-link-btn" href={DASHBOARD_PATH}>Create my profile</a>}
    <button type="button" onClick={onClose}>Close</button>
   </div>
  </div>
 </div>;
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
 const [restrictionCount,setRestrictionCount]=useState(1); // 1 = first offense, 2+ = repeat offender
 const [resolvedNotice,setResolvedNotice]=useState(false); // shows once after a restriction is lifted
 const [addingPost,setAddingPost]=useState(false);
 const [openCard,setOpenCard]=useState<null|"profile"|"inbox"|"portfolio"|"posts">(null); // only one dashboard card open at a time
 const profileOpen=openCard==="profile",inboxOpen=openCard==="inbox",portfolioOpen=openCard==="portfolio",postsCardOpen=openCard==="posts";
 const [tourOpen,setTourOpen]=useState(false),[accountOpen,setAccountOpen]=useState(false),[shareOpen,setShareOpen]=useState(false),[qrOpen,setQrOpen]=useState(false);
 const [delFails,setDelFails]=useState(()=>readDelFails(user.uid));
 const hint=useHint();const showHint=hint.show;
 const [dlBusy,setDlBusy]=useState(false);
 const lockedTap=()=>showHint("lockedField");
 const confirm=useConfirm();const toast=useToast();
 const isPremium=!!profile?.premium;
 const downloadOn=isPremium&&(profile?.portfolioDownload===undefined?PORTFOLIO_DOWNLOAD_DEFAULT:profile.portfolioDownload===true);
 // Settings > Portfolio download (Premium): lets visitors save the portfolio as a .html file.
 async function toggleDownload(){
  if(!profile||!isPremium||dlBusy)return;
  const next=!downloadOn;
  setDlBusy(true);
  try{
   await setDoc(doc(profileDb,"profiles",profile.username),{portfolioDownload:next,updatedAt:serverTimestamp()},{merge:true});
   setProfile((prev:any)=>({...prev,portfolioDownload:next}));
   writeDlCache(profile.username,next);
   toast("success",next?"Portfolio download is on. Visitors can save your page as an HTML file.":"Portfolio download is off.");
  }catch(x:any){ fail(toast,x,"Unable to change portfolio download"); }
  finally{ setDlBusy(false); }
 }
 const locked=!!profile; // after initial setup: bio + any still-empty optional fields are editable
 const fieldLocked=(v:any)=>locked&&!!String(v??"").trim(); // a field that already has a value is locked
 // Profile and inbox stay hidden until asked for — except a brand-new user, who needs the create form.
 useEffect(()=>{if(!loadingProfile&&!profile&&!flagged)setOpenCard("profile");},[loadingProfile,profile,flagged]);

 // Opening the portfolio card brings it into view (it sits below the profile and inbox cards).
 useEffect(()=>{ if(portfolioOpen)document.getElementById("spts-portfolio-card")?.scrollIntoView({behavior:"smooth",block:"start"}); },[portfolioOpen]);
 useEffect(()=>{ if(postsCardOpen)document.getElementById("spts-posts-card")?.scrollIntoView({behavior:"smooth",block:"start"}); },[postsCardOpen]);

 // Arriving from "Help?" on the owner's public profile (/?tour=1): open the tour once the profile has loaded.
 const wantTour=useRef(typeof location!=="undefined"&&new URLSearchParams(location.search).get("tour")==="1");
 useEffect(()=>{
  if(loadingProfile||!wantTour.current)return;
  wantTour.current=false;
  try{history.replaceState(null,"",location.pathname);}catch{}
  setTourOpen(true);
 },[loadingProfile]);

 useEffect(()=>{
  const unwatch=watchAccountStanding(user,st=>{
   if(st.state==="ok"){
    const d=st.profile;
    setProfile(d);setU(d.username);setName(d.displayName);setBio(d.bio);setPhoto(d.photoUrl);setWeb(d.websiteUrl);setEmail(d.email);setPhone(d.phone);setEditing(false);
    setFlagged(false);
    // A restriction was just lifted: show the one-time notice, then clear the flag ourselves — no console step.
    if(d.resolvedNotice){
     setResolvedNotice(true);
     setDoc(doc(profileDb,"users",user.uid),{resolvedNotice:false},{merge:true}).catch(()=>{});
    }
   }else if(st.state==="flagged"){
    setFlagged(true);setRestrictionCount(st.restrictionCount);
   }else{
    setProfile(null);setFlagged(false);
   }
   setLoadingProfile(false);
  });
  const q=query(collection(profileDb,"posts"),where("ownerId","==",user.uid),orderBy("createdAt","desc"),limit(MAX_POSTS));
  const unposts=onSnapshot(q,s=>setPosts(s.docs.map(d=>({id:d.id,...d.data()} as any))),e=>setErr(accessText(e,ACCESS_GENERIC)));
  return ()=>{unwatch();unposts();};
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
   setTourOpen(true); // brand-new profile: show the tour
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
  if(delFails>=2){await sendToSupport();return;} // it has failed twice already: don't try again
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
   setDelFails(0);writeDelFails(user.uid,0);setAccountOpen(false);
   toast("success","Profile deleted.");
  }catch(x:any){
   const n=delFails+1;setDelFails(n);writeDelFails(user.uid,n);
   if(n>=2)await sendToSupport(); // second failure: straight to support
   else setErr(fail(toast,x,"Unable to delete profile"));
  }
  finally{setDeletingProfile(false);}
 }
 async function sendToSupport(){
  if(!profile)return;
  const go=await confirm({
   title:"Contact support to delete your profile",
   confirmLabel:"Contact support",
   body:<p className="spts-muted">We couldn't delete your profile from the app. Support can do it for you. Tap Contact support to message us on WhatsApp.</p>,
  });
  if(go)window.open(supportUrl(`Hi, I'd like to delete my profile. Username: @${profile.username}`),"_blank","noopener");
 }

 return <main className="spts-page"><header><h1><Hint quiet k="dashTitle">Dashboard</Hint></h1>
  <div className="spts-header-actions">
   <SettingsMenu onAccount={()=>setAccountOpen(true)} onHelp={()=>setTourOpen(true)} onSignOut={()=>signOut(profileAuth)} download={isPremium&&profile?{on:downloadOn,busy:dlBusy,onToggle:toggleDownload}:undefined}/>
  </div>
 </header>
 {qrOpen&&profile&&<QrModal profile={profile} onClose={()=>setQrOpen(false)}/>}
 {shareOpen&&profile&&<ShareProfileModal profile={profile} onClose={()=>setShareOpen(false)}/>}
 {accountOpen&&<AccountModal user={user} profile={profile} delFails={delFails} busy={deletingProfile} onDelete={deleteProfileOnly} onClose={()=>setAccountOpen(false)}/>}
 {tourOpen&&<Tour steps={dashboardTourSteps({profile,premium:isPremium,showProfile:()=>setOpenCard("profile"),showInbox:()=>setOpenCard("inbox"),showPortfolio:()=>setOpenCard("portfolio"),showPosts:()=>setOpenCard("posts")})} onClose={()=>setTourOpen(false)}/>}

 {resolvedNotice&&<section className="spts-card spts-resolved-notice" role="status">
  <div className="spts-card-head"><h2>Account reviewed</h2><button type="button" className="spts-ghost" onClick={()=>setResolvedNotice(false)} aria-label="Dismiss">Dismiss</button></div>
  <p className="spts-muted">Your account was reviewed and the restrictions have been removed.</p>
 </section>}

 {/* Overview is always the first thing shown. While the realtime account check is still settling,
    a skeleton fills its spot (so the page never goes blank and mysterious) and fades out into the
    real overview the instant it's ready; the action buttons wait for the same signal so they
    never flash in early either. Once something is open, the overview hides again until it's closed. */}
 {loadingProfile&&<section className="spts-card spts-overview spts-skeleton" aria-hidden="true">
  <div className="spts-skeleton-line spts-skeleton-title"/>
  <div className="spts-skeleton-line"/>
  <div className="spts-skeleton-line"/>
  <div className="spts-skeleton-line spts-skeleton-short"/>
 </section>}
 {!loadingProfile&&!flagged&&!profileOpen&&!inboxOpen&&!portfolioOpen&&!postsCardOpen&&<div className="spts-fade-in"><DashboardOverview user={user} profile={profile} loadingProfile={loadingProfile} posts={posts} premium={isPremium} downloadOn={downloadOn}
  onOpenProfile={()=>setOpenCard("profile")} onEditProfile={()=>{setOpenCard("profile");setEditing(true);}} onOpenInbox={()=>setOpenCard("inbox")} onOpenPortfolio={()=>setOpenCard("portfolio")} onOpenPosts={()=>setOpenCard("posts")} onShare={()=>setShareOpen(true)} onToggleDownload={toggleDownload}/></div>}

 {!loadingProfile&&<div className="spts-dash-actions spts-fade-in">
  {!flagged&&<button type="button" aria-expanded={profileOpen} onClick={()=>setOpenCard(c=>c==="profile"?null:"profile")}>{profileOpen?"Hide profile":profile||loadingProfile?"Manage profile":"Create profile"}</button>}
  <button type="button" aria-expanded={inboxOpen} onClick={()=>setOpenCard(c=>c==="inbox"?null:"inbox")}>{inboxOpen?"Hide inbox":"Go to inbox"}</button>
  {profile&&!flagged&&<button type="button" onClick={()=>setShareOpen(true)} {...hint.props("shareOwn")}>Share profile</button>}
  {profile&&!flagged&&<button type="button" onClick={()=>setQrOpen(true)} {...hint.props("qrOwn")}>QR code</button>}
  {profile&&!flagged&&<button type="button" aria-expanded={portfolioOpen} onClick={()=>setOpenCard(c=>c==="portfolio"?null:"portfolio")} {...hint.props("portfolioOwn")}>{portfolioOpen?"Hide portfolio":"Manage portfolio"}</button>}
  {profile&&!flagged&&<button type="button" aria-expanded={postsCardOpen} onClick={()=>setOpenCard(c=>c==="posts"?null:"posts")} {...hint.props("postsOwn")}>{postsCardOpen?"Hide posts":"Manage posts"}</button>}
 </div>}

 {flagged&&<section className="spts-card spts-fade-in">
  <div className="spts-card-head"><h2>Account restricted</h2></div>
  <AccountFlagNotice uid={user.uid} restrictionCount={restrictionCount}/>
 </section>}

 {profileOpen&&!flagged&&<section className="spts-card">
  <div className="spts-card-head">
   <h2><Hint quiet k="cardProfile">Profile</Hint></h2>
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
    <p className="spts-name">{profile.displayName} <span className="spts-muted"><Hint quiet k="usernameOwn">@{profile.username}</Hint></span></p>
    {profile.bio&&<p className="spts-muted"><ClampText text={profile.bio} plain/></p>}
   </div>
   <div className="spts-profile-summary-actions">
    <a href={`/profile/${profile.username}`}>View public profile</a>
    <button className="spts-ghost" onClick={()=>setEditing(true)}>Edit</button>
   </div>
  </div>}

  {!loadingProfile&&!editing&&!profile&&<div className="spts-empty">
   <p className="spts-muted">You don't have a public profile yet.</p>
   <button onClick={()=>setEditing(true)}>Create profile</button>
  </div>}

  {!loadingProfile&&editing&&<form onSubmit={save}>
   {locked&&<p className="spts-muted">Only your bio and empty fields can be edited. To change filled fields,{" "}
    <a className="spts-link" href={supportUrl(`Hi, I'd like to change my profile details. Username: @${profile.username}`)} target="_blank" rel="noreferrer">contact support</a>.</p>}
   <label>Username<input required={!locked} readOnly={locked} onClick={locked?lockedTap:undefined} className={locked?"spts-readonly":undefined} placeholder="yourname" value={u} onChange={e=>setU(e.target.value)} disabled={savingProfile}/></label>
   <label>Display name<input required={!locked} readOnly={locked} onClick={locked?lockedTap:undefined} className={locked?"spts-readonly":undefined} placeholder="Your name" value={name} onChange={e=>setName(e.target.value)} disabled={savingProfile}/></label>
   <label>Bio<textarea maxLength={1000} placeholder="Tell visitors about yourself" value={bio} onChange={e=>setBio(e.target.value)} disabled={savingProfile}/></label>
   <label>Profile photo URL<input readOnly={fieldLocked(profile?.photoUrl)} onClick={fieldLocked(profile?.photoUrl)?lockedTap:undefined} className={fieldLocked(profile?.photoUrl)?"spts-readonly":undefined} placeholder="https://…" value={photo} onChange={e=>setPhoto(e.target.value)} disabled={savingProfile}/></label>
   <label>Website URL<input readOnly={fieldLocked(profile?.websiteUrl)} onClick={fieldLocked(profile?.websiteUrl)?lockedTap:undefined} className={fieldLocked(profile?.websiteUrl)?"spts-readonly":undefined} placeholder="https://…" value={web} onChange={e=>setWeb(e.target.value)} disabled={savingProfile}/></label>
   <label>Public email<input type="email" readOnly={fieldLocked(profile?.email)} onClick={fieldLocked(profile?.email)?lockedTap:undefined} className={fieldLocked(profile?.email)?"spts-readonly":undefined} placeholder="Shown on your public profile" value={email} onChange={e=>setEmail(e.target.value)} disabled={savingProfile}/></label>
   <label>Public phone<input readOnly={fieldLocked(profile?.phone)} onClick={fieldLocked(profile?.phone)?lockedTap:undefined} className={fieldLocked(profile?.phone)?"spts-readonly":undefined} placeholder="Shown on your public profile" value={phone} onChange={e=>setPhone(e.target.value)} disabled={savingProfile}/></label>
   <div className="spts-form-actions">
    <SpinnerButton type="submit" busy={savingProfile} busyLabel="Saving…">{profile?"Save changes":"Create profile"}</SpinnerButton>
    {profile&&<button type="button" className="spts-ghost" onClick={cancelEdit} disabled={savingProfile}>Cancel</button>}
   </div>
  </form>}
 </section>}

 {inboxOpen&&<Messages user={user}/>}

 {profile&&!flagged&&portfolioOpen&&<PortfolioCard user={user} profile={profile}/>}

 {postsCardOpen&&profile&&!flagged&&<section className="spts-card" id="spts-posts-card">
  <div className="spts-card-head"><h2><Hint quiet k="cardPosts">Posts</Hint></h2><Hint k="postCount" plain className="spts-badge">{posts.length}/{MAX_POSTS}</Hint></div>
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
 </section>}

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
 const [postsOpen,setPostsOpen]=useState(false),[msgOpen,setMsgOpen]=useState(false),[avatarOpen,setAvatarOpen]=useState(false),[helpOpen,setHelpOpen]=useState(false);
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
  if(!s.exists())return void setNotFound(true);
  const d=s.data();
  // Repeat offenders can be fully hidden without losing their data: set `locked:true` on this doc
  // by hand in Firestore and visitors get treated exactly as if the profile didn't exist.
  if(d.locked)return void setNotFound(true);
  setP(d);
  prefetchAd(d.username||normalizeUsername(username),!!d.premium,!!d.premium&&downloadFlag(d)); // so "See portfolio" opens instantly
  const q=query(collection(profileDb,"posts"),where("ownerId","==",d.uid),orderBy("createdAt","desc"),limit(MAX_POSTS));
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
 if(!p)return <main className="spts-public"><div className="spts-profile-layout">
  <section className="spts-profile-hero spts-skeleton" role="status" aria-label="Loading profile">
   <div className="spts-skeleton-avatar"/>
   <div className="spts-skeleton-line spts-skeleton-title spts-skeleton-center"/>
   <div className="spts-skeleton-line spts-skeleton-short spts-skeleton-center"/>
   <div className="spts-skeleton-line spts-skeleton-center" style={{marginTop:16,width:"70%"}}/>
   <div className="spts-skeleton-line spts-skeleton-center" style={{width:"55%"}}/>
   <div className="spts-profile-hero-actions">
    <div className="spts-skeleton-pill"/>
    <div className="spts-skeleton-pill"/>
   </div>
  </section>
 </div></main>;
 const contacts=detectContacts(p.bio||"");
 const canDeletePosts=!!user&&user.uid===p.uid;
 const isOwner=canDeletePosts; // the signed-in owner viewing their own public page
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
 <div className={`spts-profile-layout spts-fade-in${postsOpen||msgOpen?" spts-has-panel":""}`}>

 <section className="spts-profile-hero">
  {/* Owner: back to the dashboard tour. Everyone else: a short guide to this profile. */}
  <button type="button" className="spts-help-btn" onClick={()=>{ if(canDeletePosts)window.location.assign(DASHBOARD_TOUR_URL); else setHelpOpen(true); }}>Help?</button>
  {p.photoUrl
   ?<button type="button" className="spts-avatar-btn" onClick={()=>setAvatarOpen(true)} aria-label="View profile picture full screen"><img className="spts-avatar-lg" src={p.photoUrl} alt={p.displayName}/></button>
   :<div className="spts-avatar-lg spts-avatar-fallback" onClick={()=>hint.show("noPhoto")}>{(p.displayName||"?").trim().charAt(0).toUpperCase()}</div>}
  <h1 className="spts-profile-name"><Hint quiet k="namePublic">{p.displayName}</Hint></h1>
  <p className="spts-profile-handle"><Hint quiet k="handlePublic">@{p.username}</Hint></p>
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
  {/* Visitor buttons. Owner (signed in): none. Signed in, not the owner: Share profile only. Not signed in: both. */}
  {!postsOpen&&!msgOpen&&!isOwner&&<div className="spts-hero-cta">
   <button type="button" className="spts-cta spts-cta-secondary" onClick={shareProfile} {...hint.props("share")}>{copied?<><Ico d={ICON.check}/> Link copied</>:<><Ico d={ICON.share}/> Share profile</>}</button>
   {!user&&<a className="spts-cta spts-cta-primary" href="/profiles" {...hint.props("getOwn")}>Get your own profile <Ico d={ICON.next}/></a>}
  </div>}
  <small className="spts-muted spts-contact-note"><Hint k="contactNote">{contacts.urls.length+contacts.emails.length+contacts.phones.length} contact/link items detected in bio</Hint></small>
 </section>

 {postsOpen&&<aside className="spts-profile-panel" aria-label="Posts">
  <div className="spts-panel-bar">
   <div className="spts-panel-title"><h2><Hint quiet k="postsPublic">Posts</Hint></h2><span className="spts-badge">{posts.length}</span></div>
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
 {helpOpen&&<ProfileHelp p={p} user={user} posts={posts.length} onClose={()=>setHelpOpen(false)}/>}
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
 const [busy,setBusy]=useState(false),[flagged,setFlagged]=useState(false),[restrictionCount,setRestrictionCount]=useState(1);
 const toast=useToast();const hint=useHint();
 async function go(){
  setBusy(true);
  try{ await beginUpgrade(user); } // navigates away on success
  catch(x:any){
   setBusy(false);
   if(isFlagged(x)){setFlagged(true);setRestrictionCount((x as any).restrictionCount||1);return;}
   fail(toast,x,"Couldn't start the upgrade. Please try again.");
  }
 }
 return <>
  <SpinnerButton className={`spts-upgrade-btn${className?" "+className:""}`} busy={busy} busyLabel="Please wait…" onClick={go} extra={hint.props("upgrade")}>Upgrade to Premium</SpinnerButton>
  {flagged&&<div className="spts-modal-backdrop" role="dialog" aria-modal="true" onClick={()=>setFlagged(false)}>
   <div className="spts-modal spts-modal-wide" onClick={e=>e.stopPropagation()}>
    <h3 className="spts-modal-title">Account restricted</h3>
    <div className="spts-modal-body"><AccountFlagNotice uid={user.uid} restrictionCount={restrictionCount}/></div>
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
 const [restrictionCount,setRestrictionCount]=useState(1);
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
   if(isFlagged(x)){noteAccessError(null);setErrKind("flagged");setRestrictionCount((x as any).restrictionCount||1);return;}
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
   <p className="spts-muted">Your premium public-profile theme, direct file uploads, portfolio download and portfolio requests are unlocked.</p>
   <a className="spts-ghost spts-link-btn" href={DASHBOARD_PATH}>Back to dashboard</a>
  </>}
  {status==="error"&&errKind==="flagged"&&<>
   <h2>Account restricted</h2>
   <AccountFlagNotice uid={user?.uid} restrictionCount={restrictionCount}/>
   <a className="spts-ghost spts-link-btn" href={DASHBOARD_PATH}>Back to dashboard</a>
  </>}
  {status==="error"&&errKind!=="flagged"&&<>
   <h2>Couldn't confirm your upgrade</h2>
   <p className="spts-error"><ErrText text={err}/></p>
   {errKind==="retry"&&<button type="button" onClick={()=>window.location.reload()}>Try again</button>}
   {errKind!=="retry"&&<p className="spts-muted">{errKind==="support"?"Still not working? ":""}Already paid? <a className="spts-link" href={supportUrl("Hi, I paid for Premium but the upgrade didn't confirm.")} target="_blank" rel="noreferrer">Contact support</a>.</p>}
   <a className="spts-ghost spts-link-btn" href={DASHBOARD_PATH}>Back to dashboard</a>
  </>}
 </section></main>;
}

/* ------------------------------------------------------------------ *
 * Portfolio (internal names, the /ad route and Firestore paths still say "ad")
 *
 * Firestore layout:
 *   profiles/{username}/ad/code          -> { html, startDate?, endDate? }
 *        Every profile owner (basic or Premium) uploads their own .html file
 *        from the dashboard (PortfolioUpload), choosing a duration of at least
 *        1 week; that writes { html, startDate, endDate } to this doc, and
 *        Remove stays disabled while it is live. Premium owners can also
 *        request one: it is added by hand in the Firestore console after the
 *        request arrives. startDate / endDate are OPTIONAL
 *        "YYYY-MM-DD" strings (endDate is the last day the portfolio shows).
 *        Outside that window it counts as not live, so it "expires" and the
 *        owner can upload again. Public read. Client writes: the profile's
 *        own owner only.
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
const AD_CACHE_KEY="spts_ad_v1:",AD_LASTREQ_KEY="spts_adreq_v1:",AD_PREMIUM_KEY="spts_adpremium_v1:",AD_DL_KEY="spts_addl_v1:";
// Premium owners can switch portfolio download on or off in Settings. This is the state before they choose.
const PORTFOLIO_DOWNLOAD_DEFAULT=false;
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
// Whether the profile is Premium, and whether its owner allows portfolio download, decide if the viewer shows
// the Download button. Both come from the profile document and are cached like the portfolio itself.
function readBoolCache(key:string,u:string):boolean|null{
 try{const r=localStorage.getItem(key+u);return r===null?null:r==="1";}catch{return null;}
}
function writeBoolCache(key:string,u:string,v:boolean){ try{localStorage.setItem(key+u,v?"1":"0");}catch{} }
const readPremiumCache=(u:string)=>readBoolCache(AD_PREMIUM_KEY,u);
const writePremiumCache=(u:string,v:boolean)=>writeBoolCache(AD_PREMIUM_KEY,u,v);
const readDlCache=(u:string)=>readBoolCache(AD_DL_KEY,u);
const writeDlCache=(u:string,v:boolean)=>writeBoolCache(AD_DL_KEY,u,v);
const downloadFlag=(d:any)=>d?.portfolioDownload===undefined?PORTFOLIO_DOWNLOAD_DEFAULT:d.portfolioDownload===true;
async function fetchPortfolioMeta(u:string):Promise<{premium:boolean;download:boolean}>{
 const s=await getDoc(doc(profileDb,"profiles",u));
 if(!s.exists())return {premium:false,download:false};
 const d=s.data();
 return {premium:d.premium===true,download:d.premium===true&&downloadFlag(d)};
}
// Warm the cache (used by the public profile so "See portfolio" opens instantly).
function prefetchAd(u:string,premium?:boolean,download?:boolean){
 if(typeof premium==="boolean")writePremiumCache(u,premium);
 if(typeof download==="boolean")writeDlCache(u,download);
 fetchAd(u).then(a=>writeAdCache(u,a)).catch(()=>{});
}

// Portfolio download: the saved html becomes a .html file. It has no doctype added (so it renders as it does in
// the viewer) but gets a UTF-8 charset when it has none, and is wrapped in <html> if it was only a fragment.
function toDownloadableHtml(html:string):string{
 let h=html;
 const hasCharset=/<meta[^>]+charset/i.test(h);
 if(!/<html[\s>]/i.test(h))return `<html>\n<head><meta charset="utf-8"></head>\n<body>\n${h}\n</body>\n</html>\n`;
 if(!hasCharset){
  const head=/<head(?:\s[^>]*)?>/i;
  h=head.test(h)?h.replace(head,m=>m+'<meta charset="utf-8">'):h.replace(/<html(?:\s[^>]*)?>/i,m=>m+'<head><meta charset="utf-8"></head>');
 }
 return h;
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
  if(!profile.premium)return setErr("Requesting a portfolio is for Premium members. You can upload your own from the dashboard.");
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

 return <div className="spts-portfolio-panel">
  {badge&&phase?<div className="spts-portfolio-badge"><Hint k={BADGE_HINT[phase]} plain className="spts-badge">{badge}</Hint></div>:null}
  <p className="spts-muted">
   {!ad&&<>Upload an HTML file and choose how long it stays live (1 week or more).</>}
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
 </div>;
}

/* Dashboard: one Portfolio card, opened by "Manage portfolio". Everyone can upload their own portfolio;
 * Premium members can also switch to "Request one" and have our team build it. */
function PortfolioCard({user,profile}:{user:User;profile:any}){
 const [mode,setMode]=useState<"upload"|"request">("upload");
 const premium=!!profile.premium;
 const showRequest=premium&&mode==="request";
 return <section className="spts-card" id="spts-portfolio-card">
  <div className="spts-card-head"><h2><Hint quiet k="cardPortfolio">Portfolio</Hint></h2></div>
  {premium&&<div className="spts-seg" role="tablist" aria-label="Portfolio options">
   <button type="button" role="tab" aria-selected={!showRequest} className={!showRequest?"on":""} onClick={()=>setMode("upload")}>Upload my own</button>
   <button type="button" role="tab" aria-selected={showRequest} className={showRequest?"on":""} onClick={()=>setMode("request")}>Request one</button>
  </div>}
  {showRequest?<AdRequestCard user={user} profile={profile}/>:<PortfolioUpload profile={profile}/>}
 </section>;
}

const BADGE_HINT:Record<string,HintKey>={live:"adLive",scheduled:"adScheduled",waiting:"adWaiting",expired:"adExpired"};
// One button, plus the portfolio's current state.
function AdRequestCard({user,profile}:{user:User;profile:any}){
 const [open,setOpen]=useState(false),[bump,setBump]=useState(0);
 const status=useAdStatus(user,profile.username,bump);
 const phase=status?.phase;
 const blocked=phase==="live"||phase==="scheduled";
 const badge=phase==="waiting"?"Waiting":""; // live / scheduled / expired show on the Upload tab
 const range=(s?:string,e?:string)=>s&&e?`${prettyDate(s)} – ${prettyDate(e)}`:e?`until ${prettyDate(e)}`:s?`from ${prettyDate(s)}`:"";

 return <div className="spts-portfolio-panel">
  {badge&&phase&&BADGE_HINT[phase]?<div className="spts-portfolio-badge"><Hint k={BADGE_HINT[phase]} plain className="spts-badge">{badge}</Hint></div>:null}
  <p className="spts-muted">
   {phase==="live"&&<>Your portfolio is live{status?.endDate?` until ${prettyDate(status.endDate)}`:""}. You can request again once it expires.</>}
   {phase==="scheduled"&&<>Your portfolio is ready and goes live {status?.startDate?`on ${prettyDate(status.startDate)}`:"soon"}.</>}
   {phase==="waiting"&&<>Request sent for {range(status?.startDate,status?.endDate)}. We're preparing your portfolio — it goes live once it's ready. You can send another request if something changed.</>}
   {phase==="expired"&&<>Your last portfolio expired{status?.endDate?` on ${prettyDate(status.endDate)}`:""}. Request another run any time.</>}
   {(phase==="none"||!phase)&&<>Want us to build it for you? Tap Request portfolio and say what it should show. It will appear at <a href={`/profile/${profile.username}/ad`}>/profile/{profile.username}/ad</a>.</>}
  </p>
  <div className="spts-ad-actions">
   <button type="button" disabled={blocked} onClick={()=>setOpen(true)}>Request portfolio</button>
   {phase==="live"&&<a className="spts-ad-link spts-ghost" href={`/profile/${profile.username}/ad`}>See portfolio</a>}
  </div>
  <p className="spts-muted">Requests are a Premium privilege. Or switch to Upload to use your own file.</p>
  {open&&<AdRequestModal user={user} profile={profile} onClose={()=>setOpen(false)} onSent={()=>{setOpen(false);setBump(b=>b+1);}}/>}
 </div>;
}

// Shown on the public portfolio page when there is no live portfolio.
function AdRequestCta({user,authLoading}:{user:User|null;authLoading:boolean}){
 const {loading,profile}=useOwnProfile(user);
 const [open,setOpen]=useState(false),[sent,setSent]=useState(false);
 if(sent)return <p className="spts-muted">Request sent — we'll be in touch soon.</p>;
 if(authLoading||(user&&loading))return <button type="button" disabled>Add your portfolio</button>;
 if(!user)return <>
  <a className="spts-ad-link spts-ad-cta" href="/profiles">Add your portfolio</a>
  <p className="spts-muted">Create a profile first, then upload your own portfolio.</p>
 </>;
 if(!profile)return <>
  <a className="spts-ad-link spts-ad-cta" href="/profiles">Create your profile</a>
  <p className="spts-muted">You need a profile first.</p>
 </>;
 return <>
  <a className="spts-ad-link spts-ad-cta" href={DASHBOARD_PATH}>Add your portfolio</a>
  <p className="spts-muted">Tap Manage portfolio on your dashboard to upload your own HTML file.{profile.premium?" As a Premium member you can also request one.":""}</p>
  {profile.premium&&<button type="button" onClick={()=>setOpen(true)}>Request portfolio</button>}
  {open&&<AdRequestModal user={user} profile={profile} onClose={()=>setOpen(false)} onSent={()=>{setOpen(false);setSent(true);}}/>}
 </>;
}

// Portfolio "Full screen" is remembered for the browser session: it survives a refresh and stays on until the
// viewer taps the X (or presses Esc). It ends when the tab is closed.
const BARE_KEY="spts_portfolio_fullscreen_v1";
function readBare():boolean{ try{ return sessionStorage.getItem(BARE_KEY)==="1"; }catch{ return false; } }
function writeBare(on:boolean){ try{ if(on)sessionStorage.setItem(BARE_KEY,"1"); else sessionStorage.removeItem(BARE_KEY); }catch{} }

// Public portfolio page (route + Firestore names still say "ad"). Runs the html string in a sandboxed iframe
// (no allow-same-origin), so the code can't reach this app's auth session, storage or DOM. Same for every profile.
// Premium portfolios can also offer a Download button (the owner switches it on in Settings).
// A cached copy renders on the very first paint (no loading screen); Firestore then refreshes it silently.
function AdView({username,user,authLoading}:{username:string;user:User|null;authLoading:boolean}){
 const uname=normalizeUsername(username);
 const [ad,setAd]=useState<AdDoc|null>(()=>typeof window!=="undefined"?readAdCache(uname):null);
 const [premium,setPremium]=useState<boolean|null>(()=>typeof window!=="undefined"?readPremiumCache(uname):null);
 const [dlOk,setDlOk]=useState<boolean|null>(()=>typeof window!=="undefined"?readDlCache(uname):null);
 const [settled,setSettled]=useState(false),[failed,setFailed]=useState(false),[failedText,setFailedText]=useState(ACCESS_GENERIC),[tries,setTries]=useState(0);
 const [copied,setCopied]=useState(false);
 const [bare,setBareState]=useState(()=>typeof window!=="undefined"&&readBare()); // "full screen": hides the bar and frame; the portfolio fills the window
 const setBare=(on:boolean)=>{ setBareState(on);writeBare(on); };
 const toast=useToast();
 async function copyLink(){
  try{
   await navigator.clipboard.writeText(`${location.origin}/profile/${uname}/ad`);
   setCopied(true);setTimeout(()=>setCopied(false),2000);
  }catch{ toast("error","Couldn't copy the link."); }
 }

 useEffect(()=>{
  let alive=true;
  setFailed(false);
  Promise.all([fetchAd(uname),fetchPortfolioMeta(uname).catch(()=>({premium:false,download:false}))]).then(([a,meta])=>{
   if(!alive)return;
   writeAdCache(uname,a);writePremiumCache(uname,meta.premium);writeDlCache(uname,meta.download);
   setAd(prev=>sameAd(prev,a)?prev:a); // unchanged ad => no iframe reload
   setPremium(meta.premium);setDlOk(meta.download);
   setSettled(true);
  }).catch((e:any)=>{
   if(!alive)return;
   setFailedText(accessText(e,ACCESS_GENERIC)===ACCESS_PERSIST?ACCESS_PERSIST:ACCESS_GENERIC);
   setFailed(true);setSettled(true); // permission denied, offline, etc.
  });
  return ()=>{alive=false};
 },[uname,tries]);

 const live=!!ad&&adPhase(ad,todayLocal())==="live";
 const bareOn=bare&&(live||!settled); // stays on while loading after a refresh, so the bar never flashes
 // Not the browser's Fullscreen API: this only hides the page's own frames. A floating X (or Esc) brings them back.
 useEffect(()=>{
  if(!bareOn)return;
  const el=document.documentElement;
  el.classList.add("spts-ad-bare");
  const onKey=(e:KeyboardEvent)=>{ if(e.key==="Escape")setBare(false); };
  document.addEventListener("keydown",onKey);
  return ()=>{el.classList.remove("spts-ad-bare");document.removeEventListener("keydown",onKey);};
 },[bareOn]);

 // Premium portfolios whose owner has turned download on: the visitor can save the page as a .html file.
 function downloadPortfolio(){
  if(!ad)return;
  try{
   const href=URL.createObjectURL(new Blob([toDownloadableHtml(ad.html)],{type:"text/html;charset=utf-8"}));
   const a=document.createElement("a");
   a.href=href;a.download=`${uname}-portfolio.html`;
   document.body.appendChild(a);a.click();a.remove();
   setTimeout(()=>URL.revokeObjectURL(href),1000);
   toast("success","Portfolio downloaded.");
  }catch{ toast("error","Couldn't download the portfolio."); }
 }

 return <main className={`spts-ad${bareOn?" spts-ad-bare":""}`}>
  {!bareOn&&<header className="spts-ad-bar">
   <a className="spts-ghost spts-link-btn" href={`/profile/${uname}`}><Ico d={ICON.back}/> @{uname}</a>
   <div className="spts-ad-bar-actions">
    {live&&<button type="button" className="spts-ghost" onClick={()=>setBare(true)}>Full screen</button>}
    <button type="button" className="spts-ghost" onClick={copyLink}>{copied?<><Ico d={ICON.check}/> Copied</>:"Copy link"}</button>
    {live&&premium===true&&dlOk===true&&<button type="button" className="spts-ghost" onClick={downloadPortfolio}>Download</button>}
   </div>
  </header>}
  {live&&<iframe
   className="spts-ad-frame"
   title={`Portfolio by @${uname}`}
   srcDoc={ad!.html}
   sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
   referrerPolicy="no-referrer"
  />}
  {bareOn&&<button type="button" className="spts-ad-exit" aria-label="Exit full screen" title="Exit full screen" onClick={()=>setBare(false)}><Ico d={ICON.close}/></button>}
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
