// QA Task Board — app settings.
// Edit these values, then redeploy (firebase deploy).

// Only Google accounts with this email domain can sign in.
// Keep in sync with ALLOWED_DOMAIN in firestore.rules.
export const ALLOWED_DOMAIN = "1finance.org.in";

// These people are always admins (they can manage the team and delete any task).
// Keep in sync with the list in firestore.rules.
export const ADMIN_EMAILS = ["swarup.hande@1finance.org.in"];

// Firebase web config.
// When the app is served from Firebase Hosting this is loaded automatically
// from /__/firebase/init.json and you can leave it as null.
// For local testing on another server, paste the config object from
// Firebase console → Project settings → Your apps → Web app → SDK setup.
export const FIREBASE_CONFIG = null;
