import { onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';

export const helloWorld = onCall({ region: 'europe-west3' }, () => {
  logger.info("Hello from Firebase!", { structuredData: true });
  return "Hello from Firebase!";
});