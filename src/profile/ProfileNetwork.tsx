import React, {useEffect,useMemo,useRef,useState} from "react";
import {createUserWithEmailAndPassword,onAuthStateChanged,signInWithEmailAndPassword,signOut,User} from "firebase/auth";
import {addDoc,collection,deleteDoc,doc,getDoc,getDocs,increment,limit,onSnapshot,orderBy,query,serverTimestamp,setDoc,where,writeBatch} from "firebase/firestore";
import {getDownloadURL,getStorage,ref as storageRef,uploadBytes} from "firebase/storage";
import {profileAuth,profileDb} from "../firebase/profileFirebase";
import {MAX_MESSAGES,MAX_POSTS,MIN_MESSAGE,MAX_MESSAGE,MAX_REPLIES_PER_MESSAGE,MIN_REPLY,MAX_REPLY,detectContacts,mediaTypeFromUrl,normalizeUsername,validMediaUrl,validMessage,validUsername} from "./validators";
import {encryptMessage,decryptMessage,getDeviceId} from "./crypto";
import "./profile.css";

/* ------------------------------------------------------------------ *
 * Premium — Firebase Storage reuses the same app as profileAuth, so
 * no change to the firebase config file is needed. The Paystack link
 * below is a placeholder: swap it for your real Payment Page link
 * (or generate one per-user server-side later if you want a reference
 * tied to the visit). Paystack is configured to redirect back to
 * "<your site>/profile/" after a successful
 * payment; that special "username" is intercepted in the root
 * component below and confirms the upgrade instead of loading a
 * public profile.
 * ------------------------------------------------------------------ */
const profileStorage=getStorage(profileAuth.app);
const PAYSTACK_UPGRADE_URL="https://paystack.shop/pay/bv5n43khmv";

/* Support on WhatsApp — the number is never shown; users only see "Contact support".
 * wa.me needs the number in international format, so set SUPPORT_COUNTRY_CODE
 * (digits only, e.g. "234" or "60") — it replaces the leading 0 of the local number. */
const SUPPORT_WHATSAPP="0182322555";
const SUPPORT_COUNTRY_CODE="";
function supportUrl(text:string){
 const local=SUPPORT_WHATSAPP.replace(/\D/g,"");
 const intl=SUPPORT_COUNTRY_CODE?SUPPORT_COUNTRY_CODE+local.replace(/^0+/,""):local;
 return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

/* ------------------------------------------------------------------ *
 * Shared UI primitives: Toasts, ConfirmDialog, SpinnerButton
 * These replace window.confirm / window.alert everywhere and give
 * every async action a visible loading state.
 * ------------------------------------------------------------------ */

type Toast = { id: number; kind: "success"|"error"|"info"; text: string };
const ToastCtx = React.createContext<(kind: Toast["kind"], text: string)=>void>(()=>{});
function useToast(){ return React.useContext(ToastCtx); }

function ToastHost({children}:{children?:React.ReactNode}){
 const [items,setItems]=useState<Toast[]>([]);
 const idRef=useRef(0);
 function push(kind:Toast["kind"],text:string){
  const id=++idRef.current;
  setItems(s=>[...s,{id,kind,text}]);
  setTimeout(()=>setItems(s=>s.filter(t=>t.id!==id)),4200);
 }
 return <ToastCtx.Provider value={push}>
  {children}
  <div className="spts-toast-host" role="status" aria-live="polite">
   {items.map(t=><div key={t.id} className={`spts-toast spts-toast-${t.kind}`} onClick={()=>setItems(s=>s.filter(x=>x.id!==t.id))}>
    <span className="spts-toast-icon">{t.kind==="success"?"✓":t.kind==="error"?"!":"i"}</span>
    <span>{t.text}</span>
   </div>)}
  </div>
 </ToastCtx.Provider>;
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
 children,busy,busyLabel,className,type="button",disabled,onClick,title,
}:{
 children:React.ReactNode;busy:boolean;busyLabel?:string;className?:string;
 type?:"button"|"submit";disabled?:boolean;onClick?:()=>void;title?:string;
}){
 return <button type={type} className={className} disabled={disabled||busy} onClick={onClick} title={title}>
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
    <span className="spts-media-play-icon" aria-hidden="true">▶</span>
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
  <button type="button" className="spts-media-expand" onClick={()=>setFullscreen(true)} aria-label="View full screen" title="View full screen">⛶</button>
  {fullscreen&&<MediaLightbox post={post} isVideo={isVideo} onClose={()=>setFullscreen(false)}/>}
 </div>;
}

/* ------------------------------------------------------------------ *
 * MediaLightbox — distortion-free full-screen viewing (object-fit:
 * contain regardless of orientation), closable via backdrop/✕/Esc.
 * ------------------------------------------------------------------ */
function MediaLightbox({post,isVideo,onClose}:{post:any;isVideo:boolean;onClose:()=>void}){
 useEffect(()=>{
  function onKey(e:KeyboardEvent){ if(e.key==="Escape")onClose(); }
  document.addEventListener("keydown",onKey);
  return ()=>document.removeEventListener("keydown",onKey);
 },[onClose]);
 return <div className="spts-lightbox-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
  <button type="button" className="spts-lightbox-close" onClick={onClose} aria-label="Close full screen view">✕</button>
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
 * Auto-delete warnings — shown wherever content is created, so
 * everyone understands the 24h deletion depends on this device.
 * ------------------------------------------------------------------ */
const TTL_DEVICE_CAVEAT="Auto delete works when you're online.";
function AutoDeleteNotice({text}:{text:string}){
 return <p className="spts-ttl-notice"><span aria-hidden="true">⏳</span> {text} {TTL_DEVICE_CAVEAT}</p>;
}
function AutoDeleteNoticeSm({text}:{text:string}){
 return <small className="spts-ttl-notice-sm"> {text} Different device or cleared data removes auto delete.</small>;
}

/* ------------------------------------------------------------------ *
 * Cascades — unchanged, just relocated
 * ------------------------------------------------------------------ */
async function cascadePost(postId:string){
 const b=writeBatch(profileDb); b.delete(doc(profileDb,"posts",postId));
 const [l,c]=await Promise.all([
  getDocs(query(collection(profileDb,"posts",postId,"likes"),limit(500))),
  getDocs(query(collection(profileDb,"posts",postId,"comments"),limit(500)))
 ]);
 l.forEach(x=>b.delete(x.ref)); c.forEach(x=>b.delete(x.ref)); await b.commit();
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
type TTLEntry=
 |{kind:"post";postId:string;deleteAt:number}
 |{kind:"comment";postId:string;commentId:string;deleteAt:number}
 |{kind:"like";postId:string;uid:string;deleteAt:number}
 |{kind:"conversation";conversationId:string;deleteAt:number}
 |{kind:"message";conversationId:string;messageId:string;deleteAt:number}
 |{kind:"reply";conversationId:string;messageId:string;replyId:string;deleteAt:number};

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
async function runTTLSweep(){
 const q=readTTLQueue();
 if(q.length===0)return;
 const now=Date.now();
 const due=q.filter(e=>e.deleteAt<=now);
 if(due.length===0)return;
 writeTTLQueue(q.filter(e=>e.deleteAt>now));
 for(const e of due){
  try{
   if(e.kind==="post")await cascadePost(e.postId);
   else if(e.kind==="comment")await deleteDoc(doc(profileDb,"posts",e.postId,"comments",e.commentId));
   else if(e.kind==="like")await deleteDoc(doc(profileDb,"posts",e.postId,"likes",e.uid));
   else if(e.kind==="conversation")await deleteDoc(doc(profileDb,"conversations",e.conversationId));
   else if(e.kind==="message")await cascadeMessage(e.conversationId,e.messageId);
   else if(e.kind==="reply")await deleteDoc(doc(profileDb,"conversations",e.conversationId,"messages",e.messageId,"replies",e.replyId));
  }catch{ /* best-effort: same as if the user had tried to delete and it failed */ }
 }
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
function Auth({done}:{done:()=>void}){
 const [signup,setSignup]=useState(true),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[err,setErr]=useState(""),[busy,setBusy]=useState(false);
 const toast=useToast();
 async function go(e:React.FormEvent){e.preventDefault();setErr("");setBusy(true);try{
  if(signup)await createUserWithEmailAndPassword(profileAuth,email,password);
  else await signInWithEmailAndPassword(profileAuth,email,password);
  toast("success",signup?"Account created.":"Welcome back.");
  done();
 }catch(x:any){setErr(x.message||"Authentication failed");toast("error",x.message||"Authentication failed");}
 finally{setBusy(false);}}
 return <section className="spts-card"><h2>{signup?"Create your profile":"Log in"}</h2><form onSubmit={go}>
 <label>Email<input type="email" required placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></label>
 <label>Password<input type="password" required minLength={6} placeholder="At least 6 characters" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
 <SpinnerButton type="submit" busy={busy} busyLabel={signup?"Creating…":"Logging in…"}>{signup?"Sign up":"Log in"}</SpinnerButton>
 </form>{err&&<p className="spts-error">{err}</p>}
 <button className="spts-link" onClick={()=>setSignup(!signup)} disabled={busy}>{signup?"Already registered? Log in":"Create an account"}</button></section>
}

/* ------------------------------------------------------------------ *
 * PostCard
 * ------------------------------------------------------------------ */
function PostCard({post,user,canDeletePost,onDeletePost}:{post:any;user:User|null;canDeletePost:boolean;onDeletePost:()=>Promise<void>}){
 const [likeCount,setLikeCount]=useState(0),[liked,setLiked]=useState(false),[comments,setComments]=useState<any[]>([]),[commentText,setCommentText]=useState(""),[err,setErr]=useState("");
 const [likeBusy,setLikeBusy]=useState(false),[commentBusy,setCommentBusy]=useState(false),[deleteBusy,setDeleteBusy]=useState(false);
 const [pendingDeleteId,setPendingDeleteId]=useState<string|null>(null);
 const confirm=useConfirm();const toast=useToast();

 useEffect(()=>{
  const unsubLikes=onSnapshot(collection(profileDb,"posts",post.id,"likes"),s=>{
   setLikeCount(s.size);
   setLiked(!!user&&s.docs.some(d=>d.id===user.uid));
  },e=>setErr(e.message));
  const unsubComments=onSnapshot(query(collection(profileDb,"posts",post.id,"comments"),orderBy("createdAt","asc"),limit(200)),s=>{
   setComments(s.docs.map(d=>({id:d.id,...d.data()} as any)));
  },e=>setErr(e.message));
  return ()=>{unsubLikes();unsubComments()};
 },[post.id,user?.uid]);

 async function toggleLike(){
  if(!user)return setErr("Log in to like posts.");
  setErr("");setLikeBusy(true);
  const ref=doc(profileDb,"posts",post.id,"likes",user.uid);
  try{ liked?await deleteDoc(ref):await setDoc(ref,{createdAt:serverTimestamp()}); if(!liked)scheduleAutoDelete({kind:"like",postId:post.id,uid:user.uid}); }
  catch(x:any){setErr(x.message||"Unable to update like");toast("error",x.message||"Unable to update like");}
  finally{setLikeBusy(false);}
 }

 async function addComment(e:React.FormEvent){
  e.preventDefault();
  if(!user)return setErr("Log in to comment.");
  const text=commentText.trim();
  if(!text)return;
  setErr("");setCommentBusy(true);
  try{ const ref=await addDoc(collection(profileDb,"posts",post.id,"comments"),{ownerId:user.uid,text,createdAt:serverTimestamp()}); scheduleAutoDelete({kind:"comment",postId:post.id,commentId:ref.id}); setCommentText(""); toast("success","Comment added — it auto-deletes in 24h on this device."); }
  catch(x:any){setErr(x.message||"Unable to post comment");toast("error",x.message||"Unable to post comment");}
  finally{setCommentBusy(false);}
 }

 async function deleteComment(commentId:string){
  const ok=await confirm({
   title:"Delete this comment?",
   body:<p className="spts-muted">This removes only your comment. The post, its likes, and every other comment are not affected.</p>,
   confirmLabel:"Delete comment",danger:true,
  });
  if(!ok)return;
  setPendingDeleteId(commentId);
  try{ await deleteDoc(doc(profileDb,"posts",post.id,"comments",commentId));toast("success","Comment deleted."); }
  catch(x:any){setErr(x.message||"Unable to delete comment");toast("error",x.message||"Unable to delete comment");}
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
  <p><LinkText text={post.caption}/></p>
  <div className="spts-post-actions">
   <SpinnerButton busy={likeBusy} busyLabel="…" className={liked?"spts-liked":""} onClick={toggleLike} title="Likes auto-delete after 24h on this device">
    {liked?"♥":"♡"} {likeCount}
   </SpinnerButton>
   {canDeletePost&&<SpinnerButton className="spts-ghost" busy={deleteBusy} busyLabel="Deleting…" onClick={handleDeletePost}>Delete post</SpinnerButton>}
  </div>
  <div className="spts-comments">
   {comments.length===0&&<p className="spts-muted">No comments yet.</p>}
   {comments.map(c=><div className="spts-comment" key={c.id}>
    <p><LinkText text={c.text}/></p>
    {user&&user.uid===c.ownerId&&<SpinnerButton className="spts-ghost" busy={pendingDeleteId===c.id} busyLabel="Deleting…" onClick={()=>deleteComment(c.id)}>Delete</SpinnerButton>}
   </div>)}
   <form onSubmit={addComment}>
    <input maxLength={300} placeholder={user?"Add a comment":"Log in to comment"} value={commentText} onChange={e=>setCommentText(e.target.value)} disabled={!user||commentBusy}/>
    <SpinnerButton type="submit" busy={commentBusy} busyLabel="Posting…" disabled={!user||!commentText.trim()}>Comment</SpinnerButton>
   </form>
   {user&&<AutoDeleteNoticeSm text="Comments auto-delete after 24h."/>}
  </div>
  {err&&<p className="spts-error">{err}</p>}
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
  },e=>setErr(e.message));
 },[conversationId,messageId]);

 async function sendReply(e:React.FormEvent){
  e.preventDefault();
  if(!canReply)return;
  const t=text.trim();
  if(!validMessage(t)){setErr(`Reply must be ${MIN_REPLY}-${MAX_REPLY} characters.`);return;}
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
  }catch(x:any){ setErr(x.message||"Unable to send reply");toast("error",x.message||"Unable to send reply"); }
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
  }catch(x:any){ setErr(x.message||"Unable to delete reply");toast("error",x.message||"Unable to delete reply"); }
  finally{ setPendingDeleteId(null); }
 }

 return <div className="spts-replies">
  {replies.length===0&&<p className="spts-muted">No replies.</p>}
  {replies.map(r=><div className={`spts-reply spts-reply-${r.role}`} key={r.id}>
   <span className="spts-reply-role">{r.role==="owner"?"Owner":"Visitor"}</span>
   <p><LinkText text={decrypted[r.id]??"…"}/></p>
   <SpinnerButton className="spts-ghost" busy={pendingDeleteId===r.id} busyLabel="Deleting…" onClick={()=>deleteReply(r.id)}>Delete</SpinnerButton>
  </div>)}
  {canReply&&<form className="spts-reply-form" onSubmit={sendReply}>
   <input
    maxLength={MAX_REPLY}
    placeholder="Reply…"
    value={text}
    onChange={e=>setText(e.target.value)}
    disabled={sending}
   />
   <SpinnerButton type="submit" busy={sending} busyLabel="Sending…" disabled={!text.trim()}>Reply</SpinnerButton>
  </form>}
  {canReply&&<AutoDeleteNoticeSm text="Replies auto-delete after 24h."/>}
  {err&&<p className="spts-error">{err}</p>}
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
   setDecrypted(out);
  },e=>{setErr(e.message);setLoading(false)});
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
  catch(x:any){setErr(x.message||"Unable to delete message");toast("error",x.message||"Unable to delete message");}
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
  catch(x:any){setErr(x.message||"Unable to delete visitor");toast("error",x.message||"Unable to delete visitor");setDeletingVisitor(false);}
 }

 const shownMessages=(!previewCount||showAllMessages)?messages:messages.slice(Math.max(0,messages.length-previewCount));
 const hiddenCount=messages.length-shownMessages.length;
 return <div className="spts-conversation">
  <div className="spts-conversation-head">
   <span>Visitor {visitorId.slice(0,8)}</span>
   {viewerRole==="owner"&&<SpinnerButton className="spts-ghost" busy={deletingVisitor} busyLabel="Deleting…" onClick={deleteVisitor}>Delete visitor</SpinnerButton>}
  </div>
  {loading&&<p className="spts-muted">Loading…</p>}
  {err&&<p className="spts-error">{err}</p>}
  {!loading&&messages.length===0&&<p className="spts-muted">No messages in this conversation.</p>}
  {previewCount&&hiddenCount>0&&<button type="button" className="spts-see-more" onClick={()=>setShowAllMessages(true)}>See {hiddenCount} earlier message{hiddenCount===1?"":"s"}</button>}
  {shownMessages.map(m=><div className="spts-message" key={m.id}>
   <p><LinkText text={decrypted[m.id]??"…"}/></p>
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
canReply
   />}
  </div>)}
  {previewCount&&showAllMessages&&messages.length>previewCount&&<button type="button" className="spts-see-more spts-ghost" onClick={()=>setShowAllMessages(false)}>Show less</button>}
 </div>;
}

/* ------------------------------------------------------------------ *
 * Messages inbox
 * ------------------------------------------------------------------ */
function Messages({user}:{user:User}){
 const [conversations,setConversations]=useState<any[]>([]),[loading,setLoading]=useState(true),[err,setErr]=useState("");
 useEffect(()=>{
  const q=query(collection(profileDb,"conversations"),where("profileOwnerId","==",user.uid));
  return onSnapshot(q,s=>{setConversations(s.docs.map(d=>({id:d.id,...d.data()} as any)));setLoading(false)},e=>{setErr(e.message);setLoading(false)});
 },[user.uid]);
 return <section className="spts-card">
  <div className="spts-card-head"><h2>Inbox</h2><span className="spts-badge">{conversations.length}</span></div>
  <AutoDeleteNotice text="Messages and replies auto-delete 24h after they're sent."/>
  {loading&&<p className="spts-muted">Loading messages…</p>}
  {err&&<p className="spts-error">Couldn't load messages: {err}</p>}
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
 const [addingPost,setAddingPost]=useState(false);
 const [profileOpen,setProfileOpen]=useState(false),[inboxOpen,setInboxOpen]=useState(false);
 const confirm=useConfirm();const toast=useToast();
 const isPremium=!!profile?.premium;
 const locked=!!profile; // after initial setup: bio + any still-empty optional fields are editable
 const fieldLocked=(v:any)=>locked&&!!String(v??"").trim(); // a field that already has a value is locked
 // Profile and inbox stay hidden until asked for — except a brand-new user, who needs the create form.
 useEffect(()=>{if(!loadingProfile&&!profile)setProfileOpen(true);},[loadingProfile,profile]);

 useEffect(()=>{(async()=>{
  try{
   const us=await getDoc(doc(profileDb,"users",user.uid));
   if(us.exists()){
    const p=await getDoc(doc(profileDb,"profiles",us.data().username));
    if(p.exists()){const d=p.data();setProfile(d);setU(d.username);setName(d.displayName);setBio(d.bio);setPhoto(d.photoUrl);setWeb(d.websiteUrl);setEmail(d.email);setPhone(d.phone);setEditing(false)}
   }
  }catch(x:any){setErr(x.message||"Unable to load profile");toast("error",x.message||"Unable to load profile");}
  setLoadingProfile(false);
 })();
 const q=query(collection(profileDb,"posts"),where("ownerId","==",user.uid),orderBy("createdAt","desc"),limit(MAX_POSTS));
 return onSnapshot(q,s=>setPosts(s.docs.map(d=>({id:d.id,...d.data()} as any))),e=>setErr(e.message));
 },[user.uid]);

 async function save(e:React.FormEvent){
  e.preventDefault();
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
   }catch(x:any){setErr(x.message||"Unable to save profile");toast("error",x.message||"Unable to save profile");}
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
  }catch(x:any){setErr(x.message||"Unable to save profile");toast("error",x.message||"Unable to save profile");}
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
  }catch(x:any){setErr(x.message||"Unable to add post");toast("error",x.message||"Unable to add post");}
  finally{setAddingPost(false);}
 }

 async function deletePost(postId:string){ try{await cascadePost(postId);}catch(x:any){setErr(x.message||"Unable to delete post");toast("error",x.message||"Unable to delete post");throw x;} }

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
     <li><b>Removed:</b> your public profile document and the username ↔ account link.</li>
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
  }catch(x:any){setErr(x.message||"Unable to delete profile");toast("error",x.message||"Unable to delete profile");}
  finally{setDeletingProfile(false);}
 }

 return <main className="spts-page"><header><h1>Dashboard</h1><button className="spts-ghost" onClick={()=>signOut(profileAuth)}>Log out</button></header>

 <div className="spts-dash-actions">
  <button type="button" aria-expanded={profileOpen} onClick={()=>setProfileOpen(o=>!o)}>{profileOpen?"Hide profile":profile||loadingProfile?"Manage profile":"Create profile"}</button>
  <button type="button" aria-expanded={inboxOpen} onClick={()=>setInboxOpen(o=>!o)}>{inboxOpen?"Hide inbox":"Go to inbox"}</button>
 </div>

 {profileOpen&&<section className="spts-card">
  <div className="spts-card-head">
   <h2>Profile</h2>
   <div className="spts-card-head-badges">
    {!editing&&profile&&<span className="spts-badge">Live</span>}
    {isPremium&&<span className="spts-premium-tag">✦ Premium</span>}
    {!isPremium&&profile&&<a className="spts-upgrade-btn" href={`${PAYSTACK_UPGRADE_URL}?email=${encodeURIComponent(user.email||"")}`} target="_blank" rel="noreferrer">Upgrade to Premium</a>}
   </div>
  </div>
  {loadingProfile&&<p className="spts-muted">Loading…</p>}

  {!loadingProfile&&!editing&&profile&&<div className="spts-profile-summary">
   {profile.photoUrl&&<img className="spts-avatar-sm" src={profile.photoUrl} alt=""/>}
   <div>
    <p className="spts-name">{profile.displayName} <span className="spts-muted">@{profile.username}</span></p>
    {profile.bio&&<p className="spts-muted">{profile.bio}</p>}
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
  <div className="spts-card-head"><h2>Posts</h2><span className="spts-badge">{posts.length}/{MAX_POSTS}</span></div>
  <p className="spts-muted">{isPremium?"Paste a URL, or upload a file directly.":"URLs only — no uploads. Upgrade to Premium to upload files directly."}</p>
  <AutoDeleteNotice text="Posts (and their likes and comments) auto-delete 24h after you add them."/>
  <form onSubmit={add}>
   <label>Photo/video URL<input required={!isPremium} placeholder="https://…" value={url} onChange={e=>setUrl(e.target.value)} disabled={addingPost||!!file}/></label>
   {isPremium&&<label className="spts-fileupload-row">Or upload a file <span className="spts-premium-tag spts-premium-tag-sm">✦ Premium</span>
    <input type="file" accept="image/*,video/*" onChange={e=>setFile(e.target.files?.[0]||null)} disabled={addingPost}/>
   </label>}
   <label>Caption<input maxLength={500} placeholder="Optional caption" value={caption} onChange={e=>setCaption(e.target.value)} disabled={addingPost}/></label>
   <SpinnerButton type="submit" busy={addingPost} busyLabel={file?"Uploading…":"Posting…"} disabled={!url.trim()&&!file}>Add post</SpinnerButton>
  </form>
  {posts.length===0&&<p className="spts-muted">No posts yet.</p>}
  {posts.length>0&&<>
   <PostCard key={posts[0].id} post={posts[0]} user={user} canDeletePost={false} onDeletePost={()=>deletePost(posts[0].id)}/>
   <p className="spts-muted spts-dashboard-post-hint">Showing your latest post. Manage or delete posts from your public profile, which you own.</p>
   {profile&&<a className="spts-see-more" href={`/profile/${profile.username}`}>See all posts on your public profile →</a>}
  </>}
 </section>

 {err&&<p className="spts-error">{err}</p>}</main>
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
 const [postsOpen,setPostsOpen]=useState(false),[msgOpen,setMsgOpen]=useState(false);
 const confirm=useConfirm();const toast=useToast();

 useEffect(()=>{(async()=>{try{
  const s=await getDoc(doc(profileDb,"profiles",normalizeUsername(username)));
  if(!s.exists()){setNotFound(true);return;}
  setP(s.data());
  prefetchAd(s.data().username||normalizeUsername(username)); // so "See ad" opens instantly
  const q=query(collection(profileDb,"posts"),where("ownerId","==",s.data().uid),orderBy("createdAt","desc"),limit(MAX_POSTS));
  onSnapshot(q,x=>setPosts(x.docs.map(d=>({id:d.id,...d.data()} as any))),e=>setErr(e.message));
 }catch(x:any){setErr(x.message||"Unable to load profile");toast("error",x.message||"Unable to load profile");}})()},[username]);

 async function send(){
  setErr("");
  if(!p)return;
  if(!validMessage(msg))return setErr(`Use ${MIN_MESSAGE}–${MAX_MESSAGE} characters.`);
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
   setMsg("");setCount(count+1);toast("success","Sent · auto-deletes in 24h.");
  }catch(x:any){setErr(x.message||"Unable to send");toast("error",x.message||"Unable to send");}
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
  catch(x:any){toast("error",x.message||"Unable to delete post");}
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
 return <main className={`spts-public${p.premium?" spts-premium":""}`}>

 <section className="spts-profile-hero">
  {p.photoUrl?<img className="spts-avatar-lg" src={p.photoUrl} alt={p.displayName}/>:<div className="spts-avatar-lg spts-avatar-fallback" aria-hidden="true">{(p.displayName||"?").trim().charAt(0).toUpperCase()}</div>}
  <h1 className="spts-profile-name">{p.displayName}</h1>
  <p className="spts-profile-handle">@{p.username}</p>
  {p.premium&&<span className="spts-premium-badge">✦ Premium</span>}
  {p.bio&&<p className="spts-bio spts-profile-bio"><LinkText text={p.bio}/></p>}
  {(p.websiteUrl||p.email||p.phone)&&<div className="spts-profile-meta">
   {p.websiteUrl&&<a className="spts-meta-chip" href={p.websiteUrl} target="_blank" rel="noreferrer">🌐 Website</a>}
   {p.email&&<a className="spts-meta-chip" href={`mailto:${p.email}`}>✉️ Email</a>}
   {p.phone&&<a className="spts-meta-chip" href={`tel:${p.phone}`}>📞 Phone</a>}
  </div>}
  <div className="spts-profile-hero-actions">
   <button type="button" aria-expanded={postsOpen} onClick={()=>setPostsOpen(o=>!o)}>{postsOpen?"Hide posts":"See posts"}</button>
   <button type="button" aria-expanded={msgOpen} onClick={()=>setMsgOpen(o=>!o)}>{msgOpen?"Close":"Message"}</button>
  </div>
  <div className="spts-profile-hero-actions spts-hero-actions-2">
   <a className="spts-link-btn spts-ad-btn" href={`/profile/${p.username}/ad`}>See ad</a>
   <button type="button" className="spts-ghost" onClick={shareProfile}>{copied?"✓ Link copied":"Share profile"}</button>
   <a className="spts-ghost spts-link-btn" href="/profiles">Get your own profile</a>
  </div>
  <small className="spts-muted spts-contact-note">{contacts.urls.length+contacts.emails.length+contacts.phones.length} contact/link items detected in bio</small>
  {postsOpen&&<div className="spts-hero-panel">
   <section className="spts-card spts-section">
    <div className="spts-card-head"><h2>Posts</h2><span className="spts-badge">{posts.length}</span></div>
    {posts.length===0&&<p className="spts-muted spts-empty-text">No posts yet.</p>}
    <div className="spts-post-grid">
     {visiblePosts.map(x=><PostCard key={x.id} post={x} user={user} canDeletePost={canDeletePosts} onDeletePost={()=>deletePost(x.id)}/>)}
    </div>
    {!showAllPosts&&hiddenPostCount>0&&<button type="button" className="spts-see-more" onClick={()=>setShowAllPosts(true)}>See {hiddenPostCount} more</button>}
    {showAllPosts&&posts.length>POST_PREVIEW_COUNT&&<button type="button" className="spts-see-more spts-ghost" onClick={()=>setShowAllPosts(false)}>Show less</button>}
   </section>
  </div>}
  {msgOpen&&<div className="spts-hero-panel">
   <section className="spts-card spts-section spts-messagebox">
    <div className="spts-card-head"><h2>Message</h2></div>
    <p className="spts-muted">{MIN_MESSAGE}–{MAX_MESSAGE} chars · {MAX_MESSAGES} max</p>
    <AutoDeleteNotice text="Auto-deletes in 24h."/>

    <div className="spts-messagebox-thread">
     <ConversationThread conversationId={`${p.uid}_${getDeviceId()}`} visitorId={getDeviceId()} viewerRole="visitor" previewCount={3}/>
    </div>

    <div className="spts-messagebox-compose">
     <textarea minLength={MIN_MESSAGE} maxLength={MAX_MESSAGE} value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Anonymous message…" disabled={sending}/>
     <SpinnerButton busy={sending} busyLabel="Sending…" onClick={send} disabled={!msg.trim()}>Send</SpinnerButton>
    </div>
    {err&&<div className="spts-error-box" role="alert"><span className="spts-error-icon" aria-hidden="true">!</span><span>{err}</span></div>}
   </section>
  </div>}
 </section>

 </main>
}

/* ------------------------------------------------------------------ *
 * UpgradeSuccess — landing spot for Paystack's redirect after a
 * successful payment ("…/profile/upgradesuccessConfirm"). No webhook
 * or signature check: it simply marks the signed-in user's profile as
 * premium in Firestore. Simple, as intended — just make sure this URL
 * is only reachable after Paystack's own successful-payment redirect.
 * ------------------------------------------------------------------ */
function UpgradeSuccess({user}:{user:User|null}){
 const [status,setStatus]=useState<"working"|"done"|"error">("working");
 const [err,setErr]=useState("");
 const toast=useToast();

 useEffect(()=>{(async()=>{
  if(!user){setStatus("error");setErr("Log in with the account you upgraded, then reopen this page.");return;}
  try{
   const us=await getDoc(doc(profileDb,"users",user.uid));
   if(!us.exists()){setStatus("error");setErr("Create your public profile first, then upgrade.");return;}
   const uname=us.data().username;
   await setDoc(doc(profileDb,"profiles",uname),{premium:true,updatedAt:serverTimestamp()},{merge:true});
   setStatus("done");
   toast("success","You're upgraded to Premium.");
  }catch(x:any){setStatus("error");setErr(x.message||"Unable to confirm your upgrade.");toast("error",x.message||"Unable to confirm your upgrade.");}
 })();},[user]);

 return <main className="spts-page"><section className="spts-card spts-upgrade-confirm">
  {status==="working"&&<><span className="spts-spinner spts-spinner-lg" aria-hidden="true"/><p className="spts-muted">Confirming your payment…</p></>}
  {status==="done"&&<>
   <h2>You're Premium <span aria-hidden="true">✦</span></h2>
   <p className="spts-muted">Your premium public-profile theme and direct file uploads are unlocked.</p>
   <a className="spts-ghost spts-link-btn" href="/">Back to dashboard</a>
  </>}
  {status==="error"&&<>
   <h2>Couldn't confirm your upgrade</h2>
   <p className="spts-error">{err}</p>
   <a className="spts-ghost spts-link-btn" href="/">Back to dashboard</a>
  </>}
 </section></main>;
}

/* ------------------------------------------------------------------ *
 * Ads
 *
 * Firestore layout:
 *   profiles/{username}/ad/code          -> { html, startDate?, endDate? }
 *        Added by hand in the Firestore console. Profile owners never
 *        touch it. startDate / endDate are OPTIONAL "YYYY-MM-DD" strings
 *        (endDate is the last day the ad shows). Outside that window the
 *        ad counts as not live, so it "expires" and the owner can request
 *        again. Public read, no client writes.
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
const AD_CACHE_KEY="spts_ad_v1:",AD_LASTREQ_KEY="spts_adreq_v1:";

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
// Warm the cache (used by the public profile so "See ad" opens instantly).
function prefetchAd(u:string){ fetchAd(u).then(a=>writeAdCache(u,a)).catch(()=>{}); }

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
  if(!profile.premium)return setErr("Ads are for Premium users.");
  if(!name.trim())return setErr("Full name is required.");
  if(mobile.replace(/\D/g,"").length<7)return setErr("Enter a valid mobile number.");
  if(desc.trim().length<AD_MIN_DESC)return setErr(`Describe the ad in at least ${AD_MIN_DESC} characters.`);
  if(!start||start<today)return setErr("Pick a start date that is today or later.");
  setErr("");setSending(true);
  try{
   const origin=typeof location!=="undefined"?location.origin:"";
   const res=await fetch(`https://formsubmit.co/ajax/${AD_REQUEST_EMAIL}`,{
    method:"POST",
    headers:{"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify({
     _subject:`Ad request from @${profile.username}`,
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
     "Ad link":`${origin}/profile/${profile.username}/ad`,
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
   toast("success","Ad request sent.");
   onSent();
  }catch(x:any){setErr(x.message||"Unable to send request");toast("error",x.message||"Unable to send request");}
  finally{setSending(false);}
 }

 return <div className="spts-modal-backdrop" role="dialog" aria-modal="true" onClick={()=>{if(!sending)onClose();}}>
  <div className="spts-modal spts-modal-wide" onClick={e=>e.stopPropagation()}>
   <h3 className="spts-modal-title">Request ad run</h3>
   <form className="spts-adform" onSubmit={submit}>
    <label>Full name<input required value={name} onChange={e=>setName(e.target.value)} autoComplete="name" disabled={sending}/></label>
    <label>Mobile<input required type="tel" inputMode="tel" placeholder="+234…" value={mobile} onChange={e=>setMobile(e.target.value)} autoComplete="tel" disabled={sending}/></label>
    <label>Description
     <textarea required maxLength={AD_MAX_DESC} placeholder="What is the ad for, and how should it look? e.g. launch event on the 12th, bold and colourful, with a book-tickets button." value={desc} onChange={e=>setDesc(e.target.value)} disabled={sending}/>
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
    {err&&<p className="spts-error" role="alert">{err}</p>}
    <div className="spts-modal-actions">
     <button type="button" className="spts-ghost" onClick={onClose} disabled={sending}>Cancel</button>
     <SpinnerButton type="submit" busy={sending} busyLabel="Sending…">Send request</SpinnerButton>
    </div>
   </form>
  </div>
 </div>;
}

/* Dashboard card. Ads are Premium-only: everyone else sees an upgrade prompt. */
function AdRequest({user,profile}:{user:User;profile:any}){
 if(!profile.premium)return <section className="spts-card">
  <div className="spts-card-head"><h2>Ad</h2><span className="spts-premium-tag spts-premium-tag-sm">✦ Premium</span></div>
  <p className="spts-muted">Ads are for Premium users.</p>
  <div className="spts-ad-actions">
   <a className="spts-upgrade-btn" href={`${PAYSTACK_UPGRADE_URL}?email=${encodeURIComponent(user.email||"")}`} target="_blank" rel="noreferrer">Upgrade to Premium</a>
  </div>
 </section>;
 return <AdRequestCard user={user} profile={profile}/>;
}

// One button, plus the ad's current state.
function AdRequestCard({user,profile}:{user:User;profile:any}){
 const [open,setOpen]=useState(false),[bump,setBump]=useState(0);
 const status=useAdStatus(user,profile.username,bump);
 const phase=status?.phase;
 const blocked=phase==="live"||phase==="scheduled";
 const badge=phase==="live"?"Live":phase==="scheduled"?"Scheduled":phase==="waiting"?"Waiting":phase==="expired"?"Expired":"";
 const range=(s?:string,e?:string)=>s&&e?`${prettyDate(s)} – ${prettyDate(e)}`:e?`until ${prettyDate(e)}`:s?`from ${prettyDate(s)}`:"";

 return <section className="spts-card">
  <div className="spts-card-head"><h2>Ad</h2>{badge&&<span className="spts-badge">{badge}</span>}</div>
  <p className="spts-muted">
   {phase==="live"&&<>Your ad is live{status?.endDate?` until ${prettyDate(status.endDate)}`:""}. You can request again once it expires.</>}
   {phase==="scheduled"&&<>Your ad is ready and goes live {status?.startDate?`on ${prettyDate(status.startDate)}`:"soon"}.</>}
   {phase==="waiting"&&<>Request sent for {range(status?.startDate,status?.endDate)}. We're preparing your ad — it goes live once it's ready. You can send another request if something changed.</>}
   {phase==="expired"&&<>Your last ad expired{status?.endDate?` on ${prettyDate(status.endDate)}`:""}. Request another run any time.</>}
   {(phase==="none"||!phase)&&<>Get an ad at <a href={`/profile/${profile.username}/ad`}>/profile/{profile.username}/ad</a>.</>}
  </p>
  <div className="spts-ad-actions">
   <button type="button" disabled={blocked} onClick={()=>setOpen(true)}>Request ad run</button>
   {phase==="live"&&<a className="spts-ad-link spts-ghost" href={`/profile/${profile.username}/ad`}>See ad</a>}
  </div>
  {open&&<AdRequestModal user={user} profile={profile} onClose={()=>setOpen(false)} onSent={()=>{setOpen(false);setBump(b=>b+1);}}/>}
 </section>;
}

// Shown on the public ad page when there is no live ad.
function AdRequestCta({user,authLoading}:{user:User|null;authLoading:boolean}){
 const {loading,profile}=useOwnProfile(user);
 const [open,setOpen]=useState(false),[sent,setSent]=useState(false);
 if(sent)return <p className="spts-muted">Request sent — we'll be in touch soon.</p>;
 if(authLoading||(user&&loading))return <button type="button" disabled>Request ad</button>;
 if(!user)return <>
  <a className="spts-ad-link spts-ad-cta" href="/profiles">Request ad</a>
  <p className="spts-muted">Ads are Premium-only. Create a profile first, then upgrade.</p>
 </>;
 if(!profile)return <>
  <a className="spts-ad-link spts-ad-cta" href="/profiles">Create your profile</a>
  <p className="spts-muted">Ads are Premium-only. You need a profile first.</p>
 </>;
 if(!profile.premium)return <>
  <a className="spts-upgrade-btn spts-ad-link" href={`${PAYSTACK_UPGRADE_URL}?email=${encodeURIComponent(user.email||"")}`} target="_blank" rel="noreferrer">Upgrade to Premium</a>
  <p className="spts-muted">Ads are for Premium users.</p>
 </>;
 return <>
  <button type="button" onClick={()=>setOpen(true)}>Request ad</button>
  {open&&<AdRequestModal user={user} profile={profile} onClose={()=>setOpen(false)} onSent={()=>{setOpen(false);setSent(true);}}/>}
 </>;
}

// Public ad page. Runs the html string in a sandboxed iframe (no
// allow-same-origin), so the ad code can't reach this app's auth session,
// storage or DOM. A cached copy renders on the very first paint (no loading
// screen); Firestore then refreshes it silently.
function AdView({username,user,authLoading}:{username:string;user:User|null;authLoading:boolean}){
 const uname=normalizeUsername(username);
 const [ad,setAd]=useState<AdDoc|null>(()=>typeof window!=="undefined"?readAdCache(uname):null);
 const [settled,setSettled]=useState(false),[failed,setFailed]=useState(false),[tries,setTries]=useState(0);
 const [copied,setCopied]=useState(false);
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
  fetchAd(uname).then(a=>{
   if(!alive)return;
   writeAdCache(uname,a);
   setAd(prev=>sameAd(prev,a)?prev:a); // unchanged ad => no iframe reload
   setSettled(true);
  }).catch(()=>{
   if(!alive)return;
   setFailed(true);setSettled(true); // permission denied, offline, etc.
  });
  return ()=>{alive=false};
 },[uname,tries]);

 const live=!!ad&&adPhase(ad,todayLocal())==="live";

 return <main className="spts-ad">
  <header className="spts-ad-bar">
   <a className="spts-ghost spts-link-btn" href={`/profile/${uname}`}>← @{uname}</a>
   <button type="button" className="spts-ghost" onClick={copyLink}>{copied?"✓ Copied":"Copy link"}</button>
  </header>
  {live&&<iframe
   className="spts-ad-frame"
   title={`Ad by @${uname}`}
   srcDoc={ad!.html}
   sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
   referrerPolicy="no-referrer"
  />}
  {!live&&!settled&&<div className="spts-ad-frame spts-ad-blank"/>}
  {!live&&settled&&!failed&&<div className="spts-public-status">
   <h1>Ad not found</h1>
   <p className="spts-muted">@{uname} has no ad live right now.</p>
   <AdRequestCta user={user} authLoading={authLoading}/>
  </div>}
  {!live&&settled&&failed&&<div className="spts-public-status">
   <h1>Couldn't load the ad</h1>
   <p className="spts-muted">Access was denied or the connection failed. Please try again.</p>
   <button type="button" onClick={()=>{setSettled(false);setTries(t=>t+1);}}>Try again</button>
  </div>}
 </main>;
}

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */
export default function ProfileNetwork({username,view}:{username?:string;view?:"ad"}){
 const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true);
 useEffect(()=>onAuthStateChanged(profileAuth,u=>{setUser(u);setLoading(false)}),[]);
 useEffect(()=>{
  runTTLSweep();
  const id=setInterval(runTTLSweep,5*60*1000);
  return ()=>clearInterval(id);
 },[]);
 // /profile/{username}/ad — pass view="ad" from your router, or let the path match below handle it.
 const adMatch=/^\/profile\/([^/]+)\/ad\/?$/.exec(typeof location!=="undefined"?location.pathname:"");
 const adUser=view==="ad"?username:adMatch?decodeURIComponent(adMatch[1]):undefined;
 // The ad page never waits for auth: the ad paints straight away, auth only matters for the "Request ad" button.
 if(adUser)return <ToastHost><AdView key={adUser} username={adUser} user={user} authLoading={loading}/></ToastHost>;
 if(loading)return <main className="spts-page">Loading…</main>;
 return <ToastHost><ConfirmHost><ActiveVideoHost>
  {username==="upgradesuccessConfirm"?<UpgradeSuccess user={user}/>
   :username?<PublicProfile username={username} user={user}/>
   :user?<Dashboard user={user}/>
   :<main className="spts-page"><Auth done={()=>{}}/></main>}
 </ActiveVideoHost></ConfirmHost></ToastHost>;
  }
