import {
  createRequest,
  getWorkerRequests,
  getAllRequests,
  getRequestById,
  updateRequestStatus,
  getPendingCount,
} from '../models/profileUpdateRequestModel.js';
import { updateWorker } from '../models/workerModel.js';

export const submitRequest = async (req, res) => {
  try {
    const { changes } = req.body;
    if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) {
      return res.status(400).json({ message: 'No changes provided' });
    }
    const request = await createRequest(req.user.id, changes);
    return res.status(201).json({ message: 'Profile update request submitted', request });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const myRequests = async (req, res) => {
  try {
    const requests = await getWorkerRequests(req.user.id);
    return res.json(requests);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listAll = async (req, res) => {
  try {
    const { status } = req.query;
    const requests = await getAllRequests(status);
    return res.json(requests);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getRequest = async (req, res) => {
  try {
    const request = await getRequestById(req.params.id);
    return res.json(request);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const approveRequest = async (req, res) => {
  try {
    const { reviewer_notes } = req.body || {};
    const request = await getRequestById(req.params.id);
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request is not pending' });
    }
    await updateRequestStatus(req.params.id, 'approved', req.user.id, reviewer_notes || null);
    await updateWorker(request.worker_id, request.requested_changes);
    return res.json({ message: 'Profile update approved and applied' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const rejectRequest = async (req, res) => {
  try {
    const { reviewer_notes } = req.body || {};
    const request = await getRequestById(req.params.id);
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request is not pending' });
    }
    await updateRequestStatus(req.params.id, 'rejected', req.user.id, reviewer_notes || null);
    return res.json({ message: 'Profile update request rejected' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const pendingCount = async (req, res) => {
  try {
    const count = await getPendingCount();
    return res.json({ count });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
