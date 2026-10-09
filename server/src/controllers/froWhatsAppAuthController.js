import db from '../config/db.js';
import jwt from 'jsonwebtoken';

export async function whatsappAutoLogin(req, res) {
  try {
    const workerId = req.user.id;
    if (!workerId || workerId === 'master') {
      return res.status(400).json({ message: 'Worker identity required' });
    }

    const { data: agentsRaw, error: agentsErr } = await db
      .rpc('get_worker_agents', { p_worker_id: workerId });

    if (agentsErr) {
      console.error('[auto-login] get_worker_agents error:', agentsErr.message);
      return res.status(500).json({ message: 'Failed to load agents' });
    }

    const agents = typeof agentsRaw === 'string' ? JSON.parse(agentsRaw) : (agentsRaw || []);

    if (agents.length === 0) {
      return res.json({ sessions: [] });
    }

    const sessions = [];
    for (const agent of agents) {
      const token = jwt.sign(
        { id: agent.id, email: agent.email, role: 'agent', name: agent.name },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      if (agent.assigned_account_id && agent.assigned_account_name) {
        sessions.push({
          agentId: agent.id,
          agentEmail: agent.email,
          agentName: agent.name,
          project: agent.assigned_account_project,
          account: { id: agent.assigned_account_id, name: agent.assigned_account_name, project: agent.assigned_account_project, phone_number_id: agent.assigned_phone_number },
          token,
        });
      } else {
        const accounts = (agent.whatsapp_accounts || []).filter(a => a.is_active);
        for (const account of accounts) {
          sessions.push({
            agentId: agent.id,
            agentEmail: agent.email,
            agentName: agent.name,
            project: account.project,
            account: { id: account.id, name: account.name, project: account.project, phone_number_id: account.phone_number_id },
            token,
          });
        }
      }
    }

    return res.json({ sessions });
  } catch (error) {
    console.error('[auto-login] error:', error?.message);
    return res.status(500).json({ message: 'Auto-login failed' });
  }
}

export async function whatsappLogin(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const masterEmail = process.env.WHATSAPP_MASTER_EMAIL;
    const masterPassword = process.env.WHATSAPP_MASTER_PASSWORD;

    if (masterEmail && masterPassword && email === masterEmail && password === masterPassword) {
      const token = jwt.sign(
        { id: 'master', email: masterEmail, role: 'master', name: 'Master Admin' },
        process.env.JWT_SECRET,
        { expiresIn: '100y' }
      );
      return res.json({
        success: true,
        token,
        role: 'master',
        user: {
          id: 'master',
          name: 'Master Admin',
          email: masterEmail,
          role: 'master',
        },
        account: null,
      });
    }

    let userData = null;
    let token = null;

    const { data: authData, error: authError } = await db.auth.signInWithPassword({
      email,
      password,
    });

    if (!authError && authData?.user) {
      const { data: dbUser } = await db
        .rpc('get_whatsapp_user', { p_id: authData.user.id });

      userData = typeof dbUser === 'string' ? JSON.parse(dbUser) : dbUser;
      token = authData.session?.access_token;
    }

    if (!userData) {
      const { data: agentData, error: agentErr } = await db
        .rpc('verify_agent', {
          p_email: email,
          p_password: password,
        });

      if (agentErr || !agentData) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      userData = typeof agentData === 'string' ? JSON.parse(agentData) : agentData;
      const agentExpiry = '100y';
      token = jwt.sign(
        { id: userData.id, email: userData.email, role: 'agent', name: userData.name },
        process.env.JWT_SECRET,
        { expiresIn: agentExpiry }
      );
    }

    const { data: assignment } = await db
      .from('agent_phone_assignments')
      .select('*, whatsapp_accounts!inner(id, name, project, phone_number_id)')
      .eq('user_id', userData.id)
      .maybeSingle();

    const account = assignment?.whatsapp_accounts || null;

    return res.json({
      success: true,
      token,
      user: {
        id: userData.id,
        name: userData.name || userData.first_name || email.split('@')[0],
        email: userData.email || email,
        role: userData.role || 'agent',
      },
      account,
    });
  } catch (error) {
    return res.status(500).json({ message: 'Login failed' });
  }
}
