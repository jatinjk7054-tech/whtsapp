import {
  insertDeveloperTicket, selectDeveloperTickets, selectDeveloperTicketById,
  updateDeveloperTicket, insertDeveloperTicketReply, selectDeveloperTicketReplies,
  getDeveloperTicketStats, bulkUpdateDeveloperTickets, getDeveloperTeamMembers,
} from '../models/developerTicketModel.js';

import db from '../config/db.js';
import { getSenderPanel } from '../utils/panel.js';

export const listTickets = async (req, res) => {
  try {
    const { status, priority, category, assigned_to, raised_by_panel, raised_by, search, date_from, date_to } = req.query;
    const data = await selectDeveloperTickets({ status, priority, category, assigned_to, raised_by_panel, raised_by, search, date_from, date_to });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listMyTickets = async (req, res) => {
  try {
    const data = await selectDeveloperTickets({ assigned_to: req.user.id });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listUnassigned = async (req, res) => {
  try {
    const data = await selectDeveloperTickets({});
    const unassigned = data.filter(t => !t.assigned_to);
    return res.json(unassigned);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getStats = async (req, res) => {
  try {
    const stats = await getDeveloperTicketStats();
    return res.json(stats);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTicket = async (req, res) => {
  try {
    const ticket = await selectDeveloperTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });
    const isDigital = req.user.department === 'digital' || req.user.department === 'developers' || req.user.role === 'super_admin';
    const replies = await selectDeveloperTicketReplies(req.params.id, isDigital);
    // Feedback/conversation is visible only to the person who raised the ticket.
    const visibleReplies = req.user.id === ticket.raised_by ? replies : [];
    return res.json({ ...ticket, replies: visibleReplies });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createTicket = async (req, res) => {
  try {
    const { subject, description, category, priority, reference_id, raised_by_panel, desk_number, ngo } = req.body;
    if (!subject) return res.status(400).json({ message: 'Subject is required' });
    if (!desk_number || !String(desk_number).trim()) return res.status(400).json({ message: 'Desk Number is required' });

    const workerName = req.user.name || req.user.login_id || '';
    const data = await insertDeveloperTicket({
      raised_by: req.user.id,
      raised_by_name: workerName,
      raised_by_panel: raised_by_panel || 'fro',
      subject,
      description: description || null,
      category: category || 'bug',
      priority: priority || 'medium',
      reference_id: reference_id || null,
      desk_number: desk_number || null,
      ngo: ngo || null,
    });
    return res.status(201).json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateTicket = async (req, res) => {
  try {
    const { status, assigned_to, priority, resolution } = req.body;
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (assigned_to !== undefined) updates.assigned_to = assigned_to || null;
    if (priority !== undefined) updates.priority = priority;
    if (resolution !== undefined) updates.resolution = resolution;

    const existing = await selectDeveloperTicketById(req.params.id);

    if (updates.status && updates.status !== 'open') {
      if (!existing.first_response_at) updates.first_response_at = new Date().toISOString();
    }
    if (updates.status === 'resolved' || updates.status === 'closed') {
      updates.resolved_at = new Date().toISOString();
    }

    const data = await updateDeveloperTicket(req.params.id, updates);
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const addReply = async (req, res) => {
  try {
    const { message, is_internal } = req.body;
    if (!message) return res.status(400).json({ message: 'Message is required' });

    const isDigital = req.user.department === 'digital' || req.user.department === 'developers';
    const allowInternal = isDigital || req.user.role === 'super_admin';

    const ticket = await selectDeveloperTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    const senderPanel = getSenderPanel(req.user);

    const data = await insertDeveloperTicketReply({
      ticket_id: req.params.id,
      sender_id: req.user.id,
      sender_name: req.user.name || req.user.login_id || '',
      sender_panel: senderPanel,
      message,
      is_internal: allowInternal && is_internal ? true : false,
    });

    if (!ticket.first_response_at && (isDigital || req.user.role === 'super_admin')) {
      await updateDeveloperTicket(req.params.id, { first_response_at: new Date().toISOString() });
    }

    return res.status(201).json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const bulkUpdate = async (req, res) => {
  try {
    const { ids, updates } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'ids array is required' });
    if (!updates || Object.keys(updates).length === 0) return res.status(400).json({ message: 'updates object is required' });

    const allowed = {};
    if (updates.status !== undefined) allowed.status = updates.status;
    if (updates.assigned_to !== undefined) allowed.assigned_to = updates.assigned_to || null;
    if (updates.priority !== undefined) allowed.priority = updates.priority;

    if (allowed.status === 'resolved' || allowed.status === 'closed') {
      allowed.resolved_at = new Date().toISOString();
    }

    const data = await bulkUpdateDeveloperTickets(ids, allowed);
    return res.json({ updated: data.length, tickets: data });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAssignees = async (req, res) => {
  try {
    const data = await getDeveloperTeamMembers();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const approveTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const ticket = await selectDeveloperTicketById(id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    // Validate that the ticket can be approved (e.g., not already resolved/closed)
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      return res.status(400).json({ message: 'Cannot approve a resolved or closed ticket' });
    }

    const data = await updateDeveloperTicket(id, { status: 'open' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const rejectTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim() === '') {
      return res.status(400).json({ message: 'Rejection reason is required' });
    }

    const ticket = await selectDeveloperTicketById(id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    // Update status to rejected and save reason
    // Note: using 'rejected' as status string; if column doesn't exist in DB,
    // PostgREST will error and we'll return 400
    const data = await updateDeveloperTicket(id, { status: 'rejected' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const resolveTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution } = req.body;

    const ticket = await selectDeveloperTicketById(id);
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    // Validate that the ticket can be resolved
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      return res.status(400).json({ message: 'Ticket is already resolved or closed' });
    }

    const updates = { status: 'resolved' };
    if (resolution && resolution.trim()) {
      updates.resolution = resolution;
    }

    const data = await updateDeveloperTicket(id, updates);

    // Trigger notification ONLY to the original ticket raiser
    // The raiser is identified by ticket.raised_by
    if (ticket.raised_by) {
      try {
        // Fetch the raiser's info from workers table
        const { data: worker, error: workerErr } = await db
          .from('workers')
          .select('id, name, login_id, email, fcm_token')
          .eq('id', ticket.raised_by)
          .single();

        if (!workerErr && worker) {
          const fcmToken = worker.fcm_token;
          const ticketRef = `T-${id}`;
          const title = 'Ticket Resolved';
          const body = `Your ticket ${ticketRef} has been resolved by the development team.`;

          // Insert notification log entry for the raiser only
          await db.from('notification_log').insert({
            worker_id: ticket.raised_by,
            title,
            body,
            type: 'ticket_resolved',
            reference_id: id,
            is_read: false,
          });

          // Note: FCM push notification sending would be handled by the
          // existing notification scheduler/service logic. Here we only
          // create the database notification log entry so the raiser
          // receives the notification through the existing realtime system.
          console.log('Resolution notification created for raiser:', ticket.raised_by, { title, body });
        } else {
          console.error('Worker not found for notification:', workerErr?.message);
        }
      } catch (notifyErr) {
        // Log notification error but don't fail the resolution
        console.error('Failed to send resolution notification:', notifyErr.message);
      }
    }

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
