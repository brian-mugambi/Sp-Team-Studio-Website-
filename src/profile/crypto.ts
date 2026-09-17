/*
Requested encryption: time + deviceId are used as key material.
This is intentionally retained even though it is weaker than a modern identity/key-exchange design.
The device ID is random per browser installation; it is not a secret authentication credential.
*/
const DEVICE_KEY = "spts-anonymous-device-id";

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}
function b64(a: Uint8Array) { let s=""; a.forEach(x=>s+=String.fromCharCode(x)); return btoa(s); }
function unb64(s:string) { const x=atob(s); return Uint8Array.from(x,c=>c.charCodeAt(0)); }

async function key(time:number, deviceId:string) {
  const m = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${time}:${deviceId}`),
    "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name:"PBKDF2",salt:new TextEncoder().encode("SPTS-message"),iterations:120000,hash:"SHA-256"},
    m,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
}
export async function encryptMessage(text:string) {
  const deviceId=getDeviceId(), time=Date.now(), iv=crypto.getRandomValues(new Uint8Array(12));
  const k=await key(time,deviceId);
  const c=await crypto.subtle.encrypt({name:"AES-GCM",iv},k,new TextEncoder().encode(text));
  return {ciphertext:b64(new Uint8Array(c)), time, deviceId, iv:b64(iv)};
}
export async function decryptMessage(ciphertext:string,time:number,deviceId:string,iv:string) {
  const p=await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(iv)},await key(time,deviceId),unb64(ciphertext));
  return new TextDecoder().decode(p);
}
