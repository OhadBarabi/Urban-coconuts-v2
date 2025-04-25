import * as admin from 'firebase-admin';
import { helloWorld } from './core/helloWorld';
import { onUserCreate } from './auth/onUserCreate';
import { getUserProfile } from "./users/getUserProfile";

admin.initializeApp();

console.log("Firebase Admin SDK initialized successfully.");


export { helloWorld, onUserCreate, getUserProfile };
