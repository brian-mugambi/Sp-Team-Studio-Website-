import React, {useEffect,useMemo,useState} from "react";
import {createUserWithEmailAndPassword,onAuthStateChanged,signInWithEmailAndPassword,signOut,User} from "firebase/auth";
import {addDoc,collection,deleteDoc,doc,getDoc,getDocs,increment,limit,onSnapshot,orderBy,query,serverTimestamp,setDoc,where,writeBatch} from "firebase/firestore";
import {profileAuth,profileDb} from "../firebase/profileFirebase";
import {MAX_MESSAGES,MAX_POSTS,MIN_MESSAGE,MAX_MESSAGE,detectContacts,mediaTypeFromUrl,normalizeUsername,validMediaUrl,validMessage,validUsername} from "./validators";
import {encryptMessage,getDeviceId} from "./crypto";
import "./profile.css";

const LinkText=({text}:{text:string})=><>{text.split(/(https?:\/\/[^\s]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d\s().-]{7,}\d)/gi).map((x,i)=>{
 if(/^https?:\/\//i.test(x))return <a key={i} href={x} target="_blank" rel="noreferrer">{x}</a>;
 if(/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(x))return <a key={i} href={`mailto:${x}`}>{x}</a>;
 if(/^\+?\d[\d\s().-]{7,}\d$/.test(x))return <a key={i} href={`tel:${x.replace(/[^\d+]/g,"")}`}>{x}</a>;
 return <React.Fragment key={i}>{x}</React.Fragment>;
})}</>;

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
 <input type="email" required placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)}/>
 <input type="password" required minLength={6} placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)}/>
 <button>{signup?"Sign up":"Log in"}</button></form>{err&&<p className="spts-error">{err}</p>}
 <button className="spts-link" onClick={()=>setSignup(!signup)}>{signup?"Already registered? Log in":"Create an account"}</button></section>
}

function Dashboard({user}:{user:User}){
 const [profile,setProfile]=useState<any>(null),[posts,setPosts]=useState<any[]>([]),[u,setU]=useState(""),[name,setName]=useState(""),[bio,setBio]=useState(""),[photo,setPhoto]=useState(""),[web,setWeb]=useState(""),[email,setEmail]=useState(user.email||""),[phone,setPhone]=useState(""),[url,setUrl]=useState(""),[caption,setCaption]=useState(""),[err,setErr]=useState("");
 useEffect(()=>{(async()=>{const us=await getDoc(doc(profileDb,"users",user.uid));if(us.exists()){const p=await getDoc(doc(profileDb,"profiles",us.data().username));if(p.exists()){const d=p.data();setProfile(d);setU(d.username);setName(d.displayName);setBio(d.bio);setPhoto(d.photoUrl);setWeb(d.websiteUrl);setEmail(d.email);setPhone(d.phone)}}})();const q=query(collection(profileDb,"posts"),where("ownerId","==",user.uid),orderBy("createdAt","desc"),limit(MAX_POSTS));return onSnapshot(q,s=>setPosts(s.docs.map(d=>({id:d.id,...d.data()}))))},[user.uid]);
 async function save(e:React.FormEvent){e.preventDefault();const x=normalizeUsername(u);if(!validUsername(x)){setErr("Username must be 3-24 letters, numbers or underscore.");return}const old=await getDoc(doc(profileDb,"profiles",x));if(old.exists()&&old.data().uid!==user.uid){setErr("Username already exists.");return}const p={uid:user.uid,username:x,displayName:name.trim(),bio:bio.trim(),photoUrl:photo.trim(),websiteUrl:web.trim(),email:email.trim(),phone:phone.trim(),updatedAt:serverTimestamp()};await setDoc(doc(profileDb,"profiles",x),p,{merge:true});await setDoc(doc(profileDb,"users",user.uid),{username:x,updatedAt:serverTimestamp()},{merge:true});setProfile(p);setErr("")}
 async function add(e:React.FormEvent){e.preventDefault();if(posts.length>=MAX_POSTS)return setErr("Maximum 100 posts.");if(!validMediaUrl(url))return setErr("Use a valid media URL.");await addDoc(collection(profileDb,"posts"),{ownerId:user.uid,mediaUrl:url.trim(),mediaType:mediaTypeFromUrl(url),caption:caption.trim(),createdAt:serverTimestamp(),updatedAt:serverTimestamp()});setUrl("");setCaption("")}
 async function erase(){if(!confirm("Delete your profile and all owned posts, likes, comments and messages?"))return;const b=writeBatch(profileDb);if(profile)b.delete(doc(profileDb,"profiles",profile.username));b.delete(doc(profileDb,"users",user.uid));const ps=await getDocs(query(collection(profileDb,"posts"),where("ownerId","==",user.uid),limit(100)));ps.forEach(p=>b.delete(p.ref));await b.commit();await signOut(profileAuth)}
 return <main className="spts-page"><header><h1>Profile dashboard</h1><button onClick={()=>signOut(profileAuth)}>Log out</button></header>
 <section className="spts-card"><h2>Profile</h2><form onSubmit={save}><input required placeholder="Username" value={u} onChange={e=>setU(e.target.value)}/><input required placeholder="Display name" value={name} onChange={e=>setName(e.target.value)}/><textarea maxLength={1000} placeholder="Bio" value={bio} onChange={e=>setBio(e.target.value)}/><input placeholder="Profile photo URL" value={photo} onChange={e=>setPhoto(e.target.value)}/><input placeholder="Website URL" value={web} onChange={e=>setWeb(e.target.value)}/><input type="email" placeholder="Public email" value={email} onChange={e=>setEmail(e.target.value)}/><input placeholder="Public phone" value={phone} onChange={e=>setPhone(e.target.value)}/><button>Save</button></form>{profile&&<a href={`/profile/${profile.username}`}>Open public profile</a>}</section>
 <section className="spts-card"><h2>Posts ({posts.length}/{MAX_POSTS})</h2><p>URLs only — no uploads.</p><form onSubmit={add}><input required placeholder="Photo/video URL" value={url} onChange={e=>setUrl(e.target.value)}/><input maxLength={500} placeholder="Caption" value={caption} onChange={e=>setCaption(e.target.value)}/><button>Add post</button></form>{posts.map(p=><article className="spts-post" key={p.id}>{p.mediaType==="video"?<video src={p.mediaUrl} controls/>:<img src={p.mediaUrl} alt={p.caption}/>}<p><LinkText text={p.caption}/></p><button onClick={()=>cascadePost(p.id)}>Delete</button></article>)}</section>
 <section className="spts-card"><h2>Danger zone</h2><button className="spts-danger" onClick={erase}>Delete my profile and data</button></section>{err&&<p className="spts-error">{err}</p>}</main>
}

function PublicProfile({username}:{username:string}){
 const [p,setP]=useState<any>(null),[posts,setPosts]=useState<any[]>([]),[msg,setMsg]=useState(""),[err,setErr]=useState(""),[count,setCount]=useState(0);
 useEffect(()=>{(async()=>{const s=await getDoc(doc(profileDb,"profiles",normalizeUsername(username)));if(!s.exists())return;setP(s.data());const q=query(collection(profileDb,"posts"),where("ownerId","==",s.data().uid),orderBy("createdAt","desc"),limit(MAX_POSTS));onSnapshot(q,x=>setPosts(x.docs.map(d=>({id:d.id,...d.data()}))))})()},[username]);
 async function send(){setErr("");if(!p)return;if(!validMessage(msg))return setErr(`Message must be ${MIN_MESSAGE}-${MAX_MESSAGE} characters.`);if(count>=MAX_MESSAGES)return setErr("Conversation limit reached.");try{
  const visitor=getDeviceId(),cid=`${p.uid}_${visitor}`,cr=doc(profileDb,"conversations",cid),s=await getDoc(cr),n=s.exists()?s.data().messageCount||0:0;if(n>=MAX_MESSAGES)return setErr("Conversation limit reached.");
  const e=await encryptMessage(msg.trim());await setDoc(cr,{profileOwnerId:p.uid,visitorId:visitor,messageCount:increment(1),createdAt:s.exists()?s.data().createdAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
  await addDoc(collection(cr,"messages"),{senderId:visitor,ciphertext:e.ciphertext,time:e.time,deviceId:e.deviceId,iv:e.iv,createdAt:serverTimestamp()});setMsg("");setCount(count+1)
 }catch(x:any){setErr(x.message||"Unable to send")}}
 if(!p)return <main className="spts-page"><h1>Profile not found</h1><a href="/profiles">Get your own profile</a></main>;
 const contacts=detectContacts(p.bio||"");
 return <main className="spts-public"><header><div>{p.photoUrl&&<img className="spts-avatar" src={p.photoUrl} alt=""/>}<h1>{p.displayName}</h1><p>@{p.username}</p></div><a href="/profiles">Get your own profile</a></header>
 <section className="spts-card"><p className="spts-bio"><LinkText text={p.bio||""}/></p>{p.websiteUrl&&<p>🌐 <a href={p.websiteUrl} target="_blank" rel="noreferrer">{p.websiteUrl}</a></p>}{p.email&&<p>✉️ <a href={`mailto:${p.email}`}>{p.email}</a></p>}{p.phone&&<p>📞 <a href={`tel:${p.phone}`}>{p.phone}</a></p>}<small>{contacts.urls.length+contacts.emails.length+contacts.phones.length} contact/link items detected</small><br/><button onClick={()=>navigator.clipboard?.writeText(location.href)}>Share profile</button></section>
 <section className="spts-card"><h2>Posts</h2>{posts.map(x=><article className="spts-post" key={x.id}>{x.mediaType==="video"?<video src={x.mediaUrl} controls/>:<img src={x.mediaUrl} alt={x.caption}/>}<p><LinkText text={x.caption}/></p><div><button>♡ Like</button><button>💬 Comment</button></div></article>)}</section>
 <section className="spts-card"><h2>Message anonymously</h2><p>{MIN_MESSAGE}-{MAX_MESSAGE} characters · {MAX_MESSAGES} messages/replies per conversation</p><textarea minLength={MIN_MESSAGE} maxLength={MAX_MESSAGE} value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Anonymous message"/><button onClick={send}>Send</button>{err&&<p className="spts-error">{err}</p>}</section></main>
}

export default function ProfileNetwork({username}:{username?:string}){
 const [user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true);
 useEffect(()=>onAuthStateChanged(profileAuth,u=>{setUser(u);setLoading(false)}),[]);
 if(loading)return <main className="spts-page">Loading…</main>;
 if(username)return <PublicProfile username={username}/>;
 return user?<Dashboard user={user}/>:<main className="spts-page"><Auth done={()=>location.reload()}/></main>;
}
