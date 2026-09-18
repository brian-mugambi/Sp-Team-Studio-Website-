import React, {useEffect,useMemo,useRef,useState} from "react";
import {createUserWithEmailAndPassword,onAuthStateChanged,signInWithEmailAndPassword,signOut,User} from "firebase/auth";
import {addDoc,collection,deleteDoc,doc,getDoc,getDocs,increment,limit,onSnapshot,orderBy,query,serverTimestamp,setDoc,where,writeBatch} from "firebase/firestore";
import {profileAuth,profileDb} from "../firebase/profileFirebase";
import {MAX_MESSAGES,MAX_POSTS,MIN_MESSAGE,MAX_MESSAGE,MAX_REPLIES_PER_MESSAGE,MIN_REPLY,MAX_REPLY,detectContacts,mediaTypeFromUrl,normalizeUsername,validMediaUrl,validMessage,validUsername} from "./validators";
import {encryptMessage,decryptMessage,getDeviceId} from "./crypto";
import "./profile.css";

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
  {post.mediaType==="video"?<video src={post.mediaUrl} controls/>:<img src={post.mediaUrl} alt={post.caption}/>}
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

 const shownMessages=(!previewCount||showAllMessages)?messages:messages.slice(Math.max(0,messages.length-previewCount));
 const hiddenCount=messages.length-shownMessages.length;
 return <div className="spts-conversation">
  <div className="spts-conversation-head">Visitor {visitorId.slice(0,8)}</div>
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
  [url,setUrl]=useState(""),[caption,setCaption]=useState(""),
  [err,setErr]=useState(""),[editing,setEditing]=useState(true),[loadingProfile,setLoadingProfile]=useState(true);
 const [savingProfile,setSavingProfile]=useState(false);
 const [deletingProfile,setDeletingProfile]=useState(false);
 const [addingPost,setAddingPost]=useState(false);
 const confirm=useConfirm();const toast=useToast();

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
   setProfile(p);setEditing(false);toast("success","Profile saved.");
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
  if(!validMediaUrl(url)){setErr("Use a valid media URL.");return;}
  setErr("");setAddingPost(true);
  try{
   const postRef=await addDoc(collection(profileDb,"posts"),{ownerId:user.uid,mediaUrl:url.trim(),mediaType:mediaTypeFromUrl(url),caption:caption.trim(),createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
   scheduleAutoDelete({kind:"post",postId:postRef.id});
   setUrl("");setCaption("");toast("success","Post added — it auto-deletes in 24h on this device.");
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

 <section className="spts-card">
  <div className="spts-card-head"><h2>Profile</h2>{!editing&&profile&&<span className="spts-badge">Live</span>}</div>
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
   <label>Username<input required placeholder="yourname" value={u} onChange={e=>setU(e.target.value)} disabled={savingProfile}/></label>
   <label>Display name<input required placeholder="Your name" value={name} onChange={e=>setName(e.target.value)} disabled={savingProfile}/></label>
   <label>Bio<textarea maxLength={1000} placeholder="Tell visitors about yourself" value={bio} onChange={e=>setBio(e.target.value)} disabled={savingProfile}/></label>
   <label>Profile photo URL<input placeholder="https://…" value={photo} onChange={e=>setPhoto(e.target.value)} disabled={savingProfile}/></label>
   <label>Website URL<input placeholder="https://…" value={web} onChange={e=>setWeb(e.target.value)} disabled={savingProfile}/></label>
   <label>Public email<input type="email" placeholder="Shown on your public profile" value={email} onChange={e=>setEmail(e.target.value)} disabled={savingProfile}/></label>
   <label>Public phone<input placeholder="Shown on your public profile" value={phone} onChange={e=>setPhone(e.target.value)} disabled={savingProfile}/></label>
   <div className="spts-form-actions">
    <SpinnerButton type="submit" busy={savingProfile} busyLabel="Saving…">{profile?"Save changes":"Create profile"}</SpinnerButton>
    {profile&&<button type="button" className="spts-ghost" onClick={cancelEdit} disabled={savingProfile}>Cancel</button>}
   </div>
  </form>}
 </section>

 <section className="spts-card">
  <div className="spts-card-head"><h2>Posts</h2><span className="spts-badge">{posts.length}/{MAX_POSTS}</span></div>
  <p className="spts-muted">URLs only — no uploads.</p>
  <AutoDeleteNotice text="Posts (and their likes and comments) auto-delete 24h after you add them."/>
  <form onSubmit={add}>
   <label>Photo/video URL<input required placeholder="https://…" value={url} onChange={e=>setUrl(e.target.value)} disabled={addingPost}/></label>
   <label>Caption<input maxLength={500} placeholder="Optional caption" value={caption} onChange={e=>setCaption(e.target.value)} disabled={addingPost}/></label>
   <SpinnerButton type="submit" busy={addingPost} busyLabel="Posting…" disabled={!url.trim()}>Add post</SpinnerButton>
  </form>
  {posts.length===0&&<p className="spts-muted">No posts yet.</p>}
  {posts.map(p=><PostCard key={p.id} post={p} user={user} canDeletePost onDeletePost={()=>deletePost(p.id)}/>)}
 </section>

 <Messages user={user}/>
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
 const confirm=useConfirm();const toast=useToast();

 useEffect(()=>{(async()=>{try{
  const s=await getDoc(doc(profileDb,"profiles",normalizeUsername(username)));
  if(!s.exists()){setNotFound(true);return;}
  setP(s.data());
  const q=query(collection(profileDb,"posts"),where("ownerId","==",s.data().uid),orderBy("createdAt","desc"),limit(MAX_POSTS));
  onSnapshot(q,x=>setPosts(x.docs.map(d=>({id:d.id,...d.data()} as any))),e=>setErr(e.message));
 }catch(x:any){setErr(x.message||"Unable to load profile");toast("error",x.message||"Unable to load profile");}})()},[username]);

 async function send(){
  setErr("");
  if(!p)return;
  if(!validMessage(msg))return setErr(`Message must be ${MIN_MESSAGE}-${MAX_MESSAGE} characters.`);
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
   setMsg("");setCount(count+1);toast("success","Message sent — it auto-deletes in 24h on this device.");
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
 return <main className="spts-public">

 <section className="spts-profile-hero">
  {p.photoUrl?<img className="spts-avatar-lg" src={p.photoUrl} alt={p.displayName}/>:<div className="spts-avatar-lg spts-avatar-fallback" aria-hidden="true">{(p.displayName||"?").trim().charAt(0).toUpperCase()}</div>}
  <h1 className="spts-profile-name">{p.displayName}</h1>
  <p className="spts-profile-handle">@{p.username}</p>
  {p.bio&&<p className="spts-bio spts-profile-bio"><LinkText text={p.bio}/></p>}
  {(p.websiteUrl||p.email||p.phone)&&<div className="spts-profile-meta">
   {p.websiteUrl&&<a className="spts-meta-chip" href={p.websiteUrl} target="_blank" rel="noreferrer">🌐 Website</a>}
   {p.email&&<a className="spts-meta-chip" href={`mailto:${p.email}`}>✉️ Email</a>}
   {p.phone&&<a className="spts-meta-chip" href={`tel:${p.phone}`}>📞 Phone</a>}
  </div>}
  <div className="spts-profile-hero-actions">
   <button type="button" className="spts-ghost" onClick={shareProfile}>{copied?"✓ Link copied":"Share profile"}</button>
   <a className="spts-ghost spts-link-btn" href="/profiles">Get your own profile</a>
  </div>
  <small className="spts-muted spts-contact-note">{contacts.urls.length+contacts.emails.length+contacts.phones.length} contact/link items detected in bio</small>
 </section>

 <section className="spts-card spts-section">
  <div className="spts-card-head"><h2>Posts</h2><span className="spts-badge">{posts.length}</span></div>
  {posts.length===0&&<p className="spts-muted spts-empty-text">No posts yet.</p>}
  <div className="spts-post-grid">
   {visiblePosts.map(x=><PostCard key={x.id} post={x} user={user} canDeletePost={canDeletePosts} onDeletePost={()=>deletePost(x.id)}/>)}
  </div>
  {!showAllPosts&&hiddenPostCount>0&&<button type="button" className="spts-see-more" onClick={()=>setShowAllPosts(true)}>See {hiddenPostCount} more post{hiddenPostCount===1?"":"s"}</button>}
  {showAllPosts&&posts.length>POST_PREVIEW_COUNT&&<button type="button" className="spts-see-more spts-ghost" onClick={()=>setShowAllPosts(false)}>Show less</button>}
 </section>

 <section className="spts-card spts-section">
  <div className="spts-card-head"><h2>Message anonymously</h2></div>
  <p className="spts-muted">{MIN_MESSAGE}-{MAX_MESSAGE} characters · {MAX_MESSAGES} messages/replies per conversation</p>
  <AutoDeleteNotice text="Your message (and any replies) auto-delete 24h after they're sent."/>
  <textarea minLength={MIN_MESSAGE} maxLength={MAX_MESSAGE} value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Anonymous message" disabled={sending}/>
  <SpinnerButton busy={sending} busyLabel="Sending…" onClick={send} disabled={!msg.trim()}>Send</SpinnerButton>
  {err&&<div className="spts-error-box" role="alert"><span className="spts-error-icon" aria-hidden="true">!</span><span>{err}</span></div>}
 </section>

 <section className="spts-card spts-section">
  <div className="spts-card-head"><h2>Your conversation</h2></div>
  <p className="spts-muted">Replies from {p.displayName} will appear here.</p>
  <ConversationThread conversationId={`${p.uid}_${getDeviceId()}`} visitorId={getDeviceId()} viewerRole="visitor" previewCount={3}/>
 </section>

 </main>
}
/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */
export default function ProfileNetwork({username}:{username?:string}){
 const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true);
 useEffect(()=>onAuthStateChanged(profileAuth,u=>{setUser(u);setLoading(false)}),[]);
 useEffect(()=>{
  runTTLSweep();
  const id=setInterval(runTTLSweep,5*60*1000);
  return ()=>clearInterval(id);
 },[]);
 if(loading)return <main className="spts-page">Loading…</main>;
 return <ToastHost><ConfirmHost>
  {username?<PublicProfile username={username} user={user}/>:user?<Dashboard user={user}/>:<main className="spts-page"><Auth done={()=>{}}/></main>}
 </ConfirmHost></ToastHost>;
  }
