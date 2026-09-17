import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAfUMxPHmbZGRKWDbvlNpcl-a0U27jylO8",
  authDomain: "vella-social.firebaseapp.com",
  projectId: "vella-social",
  storageBucket: "vella-social.firebasestorage.app",
  messagingSenderId: "33474121569",
  appId: "1:33474121569:web:b7578e1727a3ed58c8bf20",
  measurementId: "G-NPP1RNNM4Z"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const profileAuth = getAuth(app);
export const profileDb = getFirestore(app);
