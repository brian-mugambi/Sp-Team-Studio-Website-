import React, {useEffect,useMemo,useState} from "react";
import {createUserWithEmailAndPassword,onAuthStateChanged,signInWithEmailAndPassword,signOut,User} from "firebase/auth";
import {addDoc,collection,deleteDoc,doc,getDoc,getDocs,increment,limit,onSnapshot,orderBy,query,serverTimestamp,setDoc,where,writeBatch} from "firebase/firestore";
import {profileAuth,profileDb} from "../firebase/profileFirebase";
import {MAX_MESSAGES,MAX_POSTS,MIN_MESSAGE,MAX_MESSAGE,detectContacts,mediaTypeFromUrl,normalizeUsername,validMediaUrl,validMessage,validUsername} from "./validators";
import {encryptMessage,decryptMessage,getDeviceId} from "./crypto";
import "./profile.css";

const LinkText=({text}:{text:string})=><>{text.split(/(https?:\/\/[^\s]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d\s().-]{7,}\d)/gi).map((x,i)=>{
 if(/^https?:\/\//i.test(x))return <a key={i} href={x} target="_blank" rel="noreferrer">{x}</a>;
 if(/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(x))return <a key={i} href={`mailto:${x}`}>{x}</a>;
 if(/^\+?\d[\d\s().-]{7,}\d$/.test(x))return <a key={i} href={`tel:${x.replace(/[^\d+]/g,"")}`}>{x}</a>;
 return <React.Fragment key={i}>{x}</React.Fragment>;
})}</>;

// Deletes a post along with its own likes and comments (they can't exist without it).
// This does NOT touch any other post, and does not touch the profile or messages —
// each of those is deleted independently, from its own delete control.
async function cascadePost(postId:string){
 const b=writeBatch(profileDb); b.delete(doc(profileDb,"posts",postId));
 const [l,c]=await Promise.all([
  getDocs(query(collection(profileDb,"posts",postId,"likes"),limit(500))),
  getDocs(query(collection(profileDb,"posts",postId,"comments"),limit(500)))
 ]);
 l.forEach(x=>b.delete(x.ref)); c.forEach(x=>b.delete(x.ref)); await b.commit();
}

function Auth({done}:{done:()=>void}){
 const [signup,setSignup]=useState(true),[email,setEmail]=useState(""),[password,setPassword]=useState(""),[err,setErr]=useState("");
 async function go(e:React.FormEvent){e.preventDefault();setErr("");try{
  signup?await createUserWithEmailAndPassword(profileAuth,email,password):await signInWithEmailAndPassword(profileAuth,email,password);done();
 }catch(x:any){setErr(x.message||"Authentication failed")}}
 return <section className="spts-card"><h2>{signup?"Create your profile":"Log in"}</h2><form onSubmit={go}>
 <label>Email<input type="email" required placeholder="you@example.com" value={email} onChange={e=>setEmail(e.target.value)}/></label>
 <label>Password<input type="password" required minLength={6} placeholder="At least 6 characters" value={password} onChange={e=>setPassword(e.target.value)}/></label>
 <button>{signup?"Sign up":"Log in"}</button></form>{err&&<p className="spts-error">{err}</p>}
 <button className="spts-link" onClick={()=>setSignup(!signup)}>{signup?"Already registered? Log in":"Create an account"}</button></section>
}

// One post: image/video, a working like toggle, and a working comment thread.
// Likes and comments each have their own delete control (unlike = delete my like,
// each comment can be deleted by whoever posted it). The post itself is only
// deletable when canDeletePost is true (the owner viewing their own dashboard).
function PostCard({post,user,canDeletePost,onDeletePost}:{post:any;user:User|null;canDeletePost:boolean;onDeletePost:()=>void}){
 const [likeCount,setLikeCount]=useState(0),[liked,setLiked]=useState(false),[comments,setComments]=useState<any[]>([]),[commentText,setCommentText]=useState(""),[err,setErr]=useState("");

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
  setErr("");
  const ref=doc(profileDb,"posts",post.id,"likes",user.uid);
  try{ liked?await deleteDoc(ref):await setDoc(ref,{createdAt:serverTimestamp()}); }
  catch(x:any){setErr(x.message||"Unable to update like")}
 }

 async function addComment(e:React.FormEvent){
  e.preventDefault();
  if(!user)return setErr("Log in to comment.");
  const text=commentText.trim();
  if(!text)return;
  setErr("");
  try{ await addDoc(collection(profileDb,"posts",post.id,"comments"),{ownerId:user.uid,text,createdAt:serverTimestamp()}); setCommentText(""); }
  catch(x:any){setErr(x.message||"Unable to post comment")}
 }

 async function deleteComment(commentId:string){
  try{ await deleteDoc(doc(profileDb,"posts",post.id,"comments",commentId)); }
  catch(x:any){setErr(x.message||"Unable to delete comment")}
 }

 return <article className="spts-post">
  {post.mediaType==="video"?<video src={post.mediaUrl} controls/>:<img src={post.mediaUrl} alt={post.caption}/>}
  <p><LinkText text={post.caption}/></p>
  <div className="spts-post-actions">
   <button onClick={toggleLike} className={liked?"spts-liked":""}>{liked?"♥":"♡"} {likeCount}</button>
   {canDeletePost&&<button className="spts-ghost" onClick={onDeletePost}>Delete post</button>}
  </div>
  <div className="spts-comments">
   {comments.length===0&&<p className="spts-muted">No comments yet.</p>}
   {comments.map(c=><div className="spts-comment" key={c.id}>
    <p><LinkText text={c.text}/></p>
    {user&&user.uid===c.ownerId&&<button className="spts-ghost" onClick={()=>deleteComment(c.id)}>Delete</button>}
   </div>)}
   <form onSubmit={addComment}>
    <input maxLength={300} placeholder={user?"Add a comment":"Log in to comment"} value={commentText} onChange={e=>setCommentText(e.target.value)} disabled={!user}/>
    <button disabled={!user}>Comment</button>
   </form>
  </div>
  {err&&<p className="spts-error">{err}</p>}
 </article>;
}

// A single conversation thread on the owner's dashboard: decrypts each message
// and lets the owner delete any single message on its own.
function ConversationThread({conversationId,visitorId}:{conversationId:string;visitorId:string}){
 const [messages,setMessages]=useState<any[]>([]),[decrypted,setDecrypted]=useState<Record<string,string>>({}),[loading,setLoading]=useState(true),[err,setErr]=useState("");
 useEffect(()=>{
  const q=query(collection(profileDb,"conversations",conversationId,"messages"),orderBy("createdAt","asc"),limit(MAX_MESSAGES*2));
  return onSnapshot(q,async s=>{
   const docs=s.docs.map(d=>({id:d.id,...d.data()} as any));
   setMessages(docs);setLoading(false);
   const out:Record<string,string>={};
   for(const m of docs){try{out[m.id]=await decryptMessage(m.ciphertext,m.time,m.deviceId,m.iv)}catch{out[m.id]="[unable to decrypt]"}}
   setDecrypted(out);
  },e=>{setErr(e.message);setLoading(false)});
 },[conversationId]);
 async function deleteMessage(messageId:string){
  try{ await deleteDoc(doc(profileDb,"conversations",conversationId,"messages",messageId)); }
  catch(x:any){setErr(x.message||"Unable to delete message")}
 }
 return <div className="spts-conversation">
  <div className="spts-conversation-head">Visitor {visitorId.slice(0,8)}</div>
  {loading&&<p className="spts-muted">Loading…</p>}
  {err&&<p className="spts-error">{err}</p>}
  {!loading&&messages.length===0&&<p className="spts-muted">No messages in this conversation.</p>}
  {messages.map(m=><div className="spts-message" key={m.id}>
   <p><LinkText text={decrypted[m.id]??"…"}/></p>
   <button className="spts-ghost" onClick={()=>deleteMessage(m.id)}>Delete</button>
  </div>)}
 </div>;
}

// Lists every conversation sent to this owner. Each message inside is
// deletable individually from ConversationThread above.
function Messages({user}:{user:User}){
 const [conversations,setConversations]=useState<any[]>([]),[loading,setLoading]=useState(true),[err,setErr]=useState("");
 useEffect(()=>{
  const q=query(collection(profileDb,"conversations"),where("profileOwnerId","==",user.uid));
  return onSnapshot(q,s=>{setConversations(s.docs.map(d=>({id:d.id,...d.data()} as any)));setLoading(false)},e=>{setErr(e.message);setLoading(false)});
 },[user.uid]);
 return <section className="spts-card">
  <div className="spts-card-head"><h2>Inbox</h2><span className="spts-badge">{conversations.length}</span></div>
  {loading&&<p className="spts-muted">Loading messages…</p>}
  {err&&<p className="spts-error">Couldn't load messages: {err}</p>}
  {!loading&&!err&&conversations.length===0&&<p className="spts-muted">No messages yet. Anyone who visits your public profile can send you one.</p>}
  {conversations.map(c=><ConversationThread key={c.id} conversationId={c.id} visitorId={c.visitorId||c.id}/>)}
 </section>;
}

function Dashboard({user}:{user:User}){
 const [profile,setProfile]=useState<any>(null),[posts,setPosts]=useState<any[]>([]),[u,setU]=useState(""),[name,setName]=useState(""),[bio,setBio]=useState(""),[photo,setPhoto]=useState(""),[web,setWeb]=useState(""),[email,setEmail]=useState(user.email||""),[phone,setPhone]=useState(""),[url,setUrl]=useState(""),[caption,setCaption]=useState(""),[err,setErr]=useState(""),[editing,setEditing]=useState(true),[loadingProfile,setLoadingProfile]=useState(true);
 useEffect(()=>{(async()=>{
  try{
   const us=await getDoc(doc(profileDb,"users",user.uid));
   if(us.exists()){
    const p=await getDoc(doc(profileDb,"profiles",us.data().username));
    if(p.exists()){const d=p.data();setProfile(d);setU(d.username);setName(d.displayName);setBio(d.bio);setPhoto(d.photoUrl);setWeb(d.websiteUrl);setEmail(d.email);setPhone(d.phone);setEditing(false)}
   }
  }catch(x:any){setErr(x.message||"Unable to load profile")}
  setLoadingProfile(false);
 })();
 const q=query(collection(profileDb,"posts"),where("ownerId","==",user.uid),orderBy("createdAt","desc"),limit(MAX_POSTS));
 return onSnapshot(q,s=>setPosts(s.docs.map(d=>({id:d.id,...d.data()} as any))),e=>setErr(e.message));
 },[user.uid]);
 async function save(e:React.FormEvent){e.preventDefault();const x=normalizeUsername(u);if(!validUsername(x)){setErr("Username must be 3-24 letters, numbers or underscore.");return}try{
  const old=await getDoc(doc(profileDb,"profiles",x));if(old.exists()&&old.data().uid!==user.uid){setErr("Username already exists.");return}
  const p={uid:user.uid,username:x,displayName:name.trim(),bio:bio.trim(),photoUrl:photo.trim(),websiteUrl:web.trim(),email:email.trim(),phone:phone.trim(),updatedAt:serverTimestamp()};
  await setDoc(doc(profileDb,"profiles",x),p,{merge:true});await setDoc(doc(profileDb,"users",user.uid),{username:x,updatedAt:serverTimestamp()},{merge:true});
  setProfile(p);setEditing(false);setErr("")
 }catch(x:any){setErr(x.message||"Unable to save profile")}}
 async function add(e:React.FormEvent){e.preventDefault();if(posts.length>=MAX_POSTS)return setErr("Maximum 100 posts.");if(!validMediaUrl(url))return setErr("Use a valid media URL.");try{
  await addDoc(collection(profileDb,"posts"),{ownerId:user.uid,mediaUrl:url.trim(),mediaType:mediaTypeFromUrl(url),caption:caption.trim(),createdAt:serverTimestamp(),updatedAt:serverTimestamp()});setUrl("");setCaption("")
 }catch(x:any){setErr(x.message||"Unable to add post")}}
 async function deletePost(postId:string){if(!confirm("Delete this post and its likes/comments?"))return;try{await cascadePost(postId)}catch(x:any){setErr(x.message||"Unable to delete post")}}
 async function deleteProfileOnly(){if(!confirm("Delete your public profile? Your posts, likes, comments and messages are not affected — delete those separately if you want them gone too."))return;try{
  if(profile)await deleteDoc(doc(profileDb,"profiles",profile.username));await deleteDoc(doc(profileDb,"users",user.uid));
  setProfile(null);setU("");setName("");setBio("");setPhoto("");setWeb("");setPhone("");setEditing(true)
 }catch(x:any){setErr(x.message||"Unable to delete profile")}}
 return <main className="spts-page"><header><h1>Dashboard</h1><button className="spts-ghost" onClick={()=>signOut(profileAuth)}>Log out</button></header>

 <section className="spts-card">
  <div className="spts-card-head"><h2>Profile</h2></div>
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
    <button className="spts-danger" onClick={deleteProfileOnly}>Delete profile</button>
   </div>
  </div>}
  {!loadingProfile&&editing&&<form onSubmit={save}>
   <label>Username<input required placeholder="yourname" value={u} onChange={e=>setU(e.target.value)}/></label>
   <label>Display name<input required placeholder="Your name" value={name} onChange={e=>setName(e.target.value)}/></label>
   <label>Bio<textarea maxLength={1000} placeholder="Tell visitors about yourself" value={bio} onChange={e=>setBio(e.target.value)}/></label>
   <label>Profile photo URL<input placeholder="https://…" value={photo} onChange={e=>setPhoto(e.target.value)}/></label>
   <label>Website URL<input placeholder="https://…" value={web} onChange={e=>setWeb(e.target.value)}/></label>
   <label>Public email<input type="email" placeholder="Shown on your public profile" value={email} onChange={e=>setEmail(e.target.value)}/></label>
   <label>Public phone<input placeholder="Shown on your public profile" value={phone} onChange={e=>setPhone(e.target.value)}/></label>
   <div className="spts-form-actions"><button>Save</button>{profile&&<button type="button" className="spts-ghost" onClick={()=>setEditing(false)}>Cancel</button>}</div>
  </form>}
 </section>

 <section className="spts-card">
  <div className="spts-card-head"><h2>Posts</h2><span className="spts-badge">{posts.length}/{MAX_POSTS}</span></div>
  <p className="spts-muted">URLs only — no uploads.</p>
  <form onSubmit={add}>
   <label>Photo/video URL<input required placeholder="https://…" value={url} onChange={e=>setUrl(e.target.value)}/></label>
   <label>Caption<input maxLength={500} placeholder="Optional caption" value={caption} onChange={e=>setCaption(e.target.value)}/></label>
   <button>Add post</button>
  </form>
  {posts.length===0&&<p className="spts-muted">No posts yet.</p>}
  {posts.map(p=><PostCard key={p.id} post={p} user={user} canDeletePost onDeletePost={()=>deletePost(p.id)}/>)}
 </section>

 <Messages user={user}/>
 {err&&<p className="spts-error">{err}</p>}</main>
}

function PublicProfile({username,user}:{username:string;user:User|null}){
 const [p,setP]=useState<any>(null),[posts,setPosts]=useState<any[]>([]),[msg,setMsg]=useState(""),[err,setErr]=useState(""),[count,setCount]=useState(0),[notFound,setNotFound]=useState(false);
 useEffect(()=>{(async()=>{try{
  const s=await getDoc(doc(profileDb,"profiles",normalizeUsername(username)));
  if(!s.exists()){setNotFound(true);return}
  setP(s.data());
  const q=query(collection(profileDb,"posts"),where("ownerId","==",s.data().uid),orderBy("createdAt","desc"),limit(MAX_POSTS));
  onSnapshot(q,x=>setPosts(x.docs.map(d=>({id:d.id,...d.data()} as any))),e=>setErr(e.message));
 }catch(x:any){setErr(x.message||"Unable to load profile")}})()},[username]);
 async function send(){setErr("");if(!p)return;if(!validMessage(msg))return setErr(`Message must be ${MIN_MESSAGE}-${MAX_MESSAGE} characters.`);if(count>=MAX_MESSAGES)return setErr("Conversation limit reached.");try{
  const visitor=getDeviceId(),cid=`${p.uid}_${visitor}`,cr=doc(profileDb,"conversations",cid),s=await getDoc(cr),n=s.exists()?s.data().messageCount||0:0;if(n>=MAX_MESSAGES)return setErr("Conversation limit reached.");
  const e=await encryptMessage(msg.trim());await setDoc(cr,{profileOwnerId:p.uid,visitorId:visitor,messageCount:increment(1),createdAt:s.exists()?s.data().createdAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
  await addDoc(collection(cr,"messages"),{senderId:visitor,ciphertext:e.ciphertext,time:e.time,deviceId:e.deviceId,iv:e.iv,createdAt:serverTimestamp()});setMsg("");setCount(count+1)
 }catch(x:any){setErr(x.message||"Unable to send")}}
 if(notFound)return <main className="spts-page"><h1>Profile not found</h1><a href="/profiles">Get your own profile</a></main>;
 if(!p)return <main className="spts-page"><p className="spts-muted">Loading…</p></main>;
 const contacts=detectContacts(p.bio||"");
 const canDeletePosts=!!user&&user.uid===p.uid;
 return <main className="spts-public"><header><div>{p.photoUrl&&<img className="spts-avatar" src={p.photoUrl} alt=""/>}<h1>{p.displayName}</h1><p>@{p.username}</p></div><a href="/profiles">Get your own profile</a></header>
 <section className="spts-card"><p className="spts-bio"><LinkText text={p.bio||""}/></p>{p.websiteUrl&&<p>🌐 <a href={p.websiteUrl} target="_blank" rel="noreferrer">{p.websiteUrl}</a></p>}{p.email&&<p>✉️ <a href={`mailto:${p.email}`}>{p.email}</a></p>}{p.phone&&<p>📞 <a href={`tel:${p.phone}`}>{p.phone}</a></p>}<small className="spts-muted">{contacts.urls.length+contacts.emails.length+contacts.phones.length} contact/link items detected</small><br/><button className="spts-ghost" onClick={()=>navigator.clipboard?.writeText(location.href)}>Share profile</button></section>
 <section className="spts-card"><h2>Posts</h2>{posts.length===0&&<p className="spts-muted">No posts yet.</p>}{posts.map(x=><PostCard key={x.id} post={x} user={user} canDeletePost={canDeletePosts} onDeletePost={async()=>{if(confirm("Delete this post and its likes/comments?"))await cascadePost(x.id)}}/>)}</section>
 <section className="spts-card"><h2>Message anonymously</h2><p className="spts-muted">{MIN_MESSAGE}-{MAX_MESSAGE} characters · {MAX_MESSAGES} messages/replies per conversation</p><textarea minLength={MIN_MESSAGE} maxLength={MAX_MESSAGE} value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Anonymous message"/><button onClick={send}>Send</button>{err&&<p className="spts-error">{err}</p>}</section></main>
}

export default function ProfileNetwork({username}:{username?:string}){
 const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true);
 useEffect(()=>onAuthStateChanged(profileAuth,u=>{setUser(u);setLoading(false)}),[]);
 if(loading)return <main className="spts-page">Loading…</main>;
 if(username)return <PublicProfile username={username} user={user}/>;
 return user?<Dashboard user={user}/>:<main className="spts-page"><Auth done={()=>location.reload()}/></main>;
}
