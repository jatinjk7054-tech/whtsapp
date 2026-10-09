import db from '../config/db.js';
import { getSenderPanel, getSenderName } from '../utils/panel.js';
import { isEventTeam } from '../middleware/authMiddleware.js';

export const listTickets = async (req, res) => {
  try {
    const { status, department, category, priority, search, date_from, date_to } = req.query;
    let query = db
      .from('support_tickets')
      .select('*, workers!support_tickets_raised_by_fkey(name, login_id)')
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (department) query = query.eq('department', department);
    if (category) query = query.eq('category', category);
    if (priority) query = query.eq('priority', priority);
    if (date_from) query = query.gte('created_at', date_from);
    if (date_to) query = query.lte('created_at', date_to);
    if (search) {
      query = query.or(`subject.ilike.%${search}%,description.ilike.%${search}%,reference_id.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    const tickets = data || [];

    let comments = [];
    if (tickets.length) {
      const rc = await db
        .from('ticket_replies')
        .select('ticket_id, count')
        .in('ticket_id', tickets.map(t => t.id));
      comments = rc.data || [];
    }
    const commentMap = Object.fromEntries(comments.map(c => [c.ticket_id, c.count]));
    return res.json(tickets.map(t => ({ ...t, comment_count: commentMap[t.id] || 0 })));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listMyTickets = async (req, res) => {
  try {
    const workerId = req.user.id;
    const { data, error } = await db
      .from('support_tickets')
      .select('*')
      .eq('raised_by', workerId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const tickets = data || [];

    // Reply counts come from a grouped aggregate, never an embed. db.js only
    // resolves to-one embeds (child -> parent FK), so a to-many embed such as
    // `ticket_replies(count)` throws "Could not resolve relationship
    // support_tickets -> ticket_replies" and 500s this whole list — which is why
    // the FRO's Raise Ticket page appeared empty and no team reply was visible.
    const countMap = {};
    if (tickets.length) {
      try {
        const rc = await db
          .from('ticket_replies')
          .select('ticket_id, count')
          .in('ticket_id', tickets.map(t => t.id));
        // Postgres COUNT returns bigint, which node-postgres hands back as a
        // string, so coerce it before it reaches JSON consumers doing maths.
        for (const c of rc.data || []) countMap[c.ticket_id] = Number(c.count);
      } catch (countError) {
        // A failed count must degrade to "no replies", never hide the tickets.
        console.warn('[tickets] reply counts unavailable:', countError.message);
      }
    }
    return res.json(tickets.map(t => ({ ...t, reply_count: countMap[t.id] || 0 })));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { data: ticket, error } = await db
      .from('support_tickets')
      .select('*, workers!support_tickets_raised_by_fkey(name, login_id), users!support_tickets_resolved_by_fkey(name)')
      .eq('id', id)
      .single();
    if (error) throw error;
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    const { data: replies, error: replyError } = await db
      .from('ticket_replies')
      .select('*')
      .eq('ticket_id', id)
      .order('created_at', { ascending: true });
    if (replyError) throw replyError;

    // Feedback/conversation is visible to the person who raised the ticket, to
    // the accounts team who resolves it, and to the UFS / Event Manager team
    // working its own queue — otherwise a responder sees "No replies yet" for
    // the thread it is replying in.
    const isResolverTeam = ['accounts', 'super_admin'].includes(req.user.role) || isEventTeam(req.user);
    const visibleReplies = (isResolverTeam || req.user.id === ticket.raised_by) ? (replies || []) : [];

    return res.json({ ...ticket, replies: visibleReplies });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createTicket = async (req, res) => {
  try {
    const { department, category, subject, description, reference_id, priority, desk_number, ngo, raised_by_panel } = req.body;
    if (!subject) return res.status(400).json({ message: 'Subject is required' });
    if (!desk_number || !String(desk_number).trim()) return res.status(400).json({ message: 'Desk Number is required' });

    const { data, error } = await db
      .from('support_tickets')
      .insert({
        raised_by: req.user.id,
        department: department || 'accounts',
        category: category || 'other',
        subject,
        description: description || null,
        reference_id: reference_id || null,
        priority: priority || 'medium',
        desk_number: desk_number || null,
        ngo: ngo || null,
        raised_by_panel: raised_by_panel || null,
      })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolution, department, category, priority } = req.body;

    // The UFS / Event Manager team may only action tickets routed to its own
    // queue, and only their status/resolution — never re-route or re-categorise
    // an accounts/HR ticket. isEventTeam is the same rule the route guard uses,
    // so the guard and the scope can never disagree.
    const eventTeam = isEventTeam(req.user);
    if (eventTeam) {
      const { data: owned, error: ownedError } = await db
        .from('support_tickets')
        .select('department')
        .eq('id', id)
        .maybeSingle();
      if (ownedError) throw ownedError;
      if (!owned) return res.status(404).json({ message: 'Ticket not found' });
      if (owned.department !== 'event_head') {
        return res.status(403).json({ message: 'You can only update tickets routed to your team' });
      }
    }

    const updates = {};
    if (status !== undefined) updates.status = status;
    if (resolution !== undefined) updates.resolution = resolution;
    if (!eventTeam) {
      if (department !== undefined) updates.department = department;
      if (category !== undefined) updates.category = category;
      if (priority !== undefined) updates.priority = priority;
    }
    if (status === 'resolved' || status === 'closed') {
      // resolved_by is FK'd to users(id). Accounts staff may authenticate as
      // workers (id lives in workers, not users) and super admin auth uses
      // id 0 — neither exists in users. Only store a value that satisfies the FK.
      const { data: resolver } = await db.from('users').select('id').eq('id', req.user.id).maybeSingle();
      updates.resolved_by = resolver ? resolver.id : null;
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await db
      .from('support_tickets')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const addReply = async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ message: 'Message is required' });

    const { data: ticket } = await db
      .from('support_tickets')
      .select('id')
      .eq('id', id)
      .single();
    if (!ticket) return res.status(404).json({ message: 'Ticket not found' });

    const { data, error } = await db
      .from('ticket_replies')
      .insert({
        ticket_id: id,
        sender_id: req.user.id,
        sender_type: req.user.role === 'fro' ? 'worker' : 'user',
        sender_name: getSenderName(req.user) || null,
        sender_panel: getSenderPanel(req.user),
        message,
      })
      .select()
      .single();

    if (error) throw error;

    await db
      .from('support_tickets')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);

    return res.status(201).json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const deleteTicket = async (req, res) => {
  try {
    const { id } = req.params;
    await db.from('ticket_replies').delete().eq('ticket_id', id);
    const { data, error } = await db.from('support_tickets').delete().eq('id', id).select('id').single();
    if (error) {
      if (String(error.code) === 'PGRST116') return res.status(404).json({ message: 'Ticket not found' });
      throw error;
    }
    if (!data) return res.status(404).json({ message: 'Ticket not found' });
    return res.json({ deleted: true, id: data.id });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getWorkers = async (req, res) => {
  try {
    const { data, error } = await db
      .from('workers')
      .select('id, name, login_id, department')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
