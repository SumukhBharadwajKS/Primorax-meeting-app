import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

// Firebase web configuration. These values are public client configuration.
const firebaseConfig = {
  apiKey: 'AIzaSyDuScoa4ZHKcQQecTSsndAAj9j3vRNtpAI',
  authDomain: 'meeting-app-c8080.firebaseapp.com',
  projectId: 'meeting-app-c8080',
  storageBucket: 'meeting-app-c8080.firebasestorage.app',
  messagingSenderId: '628320235122',
  appId: '1:628320235122:web:245a99672d58bf215fdceb'
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Silently ensure anonymous authentication
export function initAuth() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        resolve(user);
      } else {
        signInAnonymously(auth)
          .then((cred) => resolve(cred.user))
          .catch(reject);
      }
    });
  });
}
