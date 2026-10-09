import { getNgoAdmins } from '../models/workerModel.js';
import { sendPushNotification } from './fcmService.js';

// Notify every NGO admin of the given NGO about an event (e.g. a new leave or
// advance request, a generated attendance code). Each admin gets a bell entry
// via sendPushNotification, plus an FCM push when a token is registered.
// Errors are swallowed so notification failures never break the main request.
export const notifyNgoAdmins = async (ngoId, title, body, type, referenceId = null) => {
  try {
    const admins = await getNgoAdmins(ngoId);
    await Promise.allSettled(
      (admins || []).map((admin) =>
        sendPushNotification(admin.id, title, body, type, referenceId)
      )
    );
  } catch (error) {
    console.error('notifyNgoAdmins failed:', error.message);
  }
};
