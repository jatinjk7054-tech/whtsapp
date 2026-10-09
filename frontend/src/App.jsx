import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, setTokenReader } from './lib/api.js';
import { clearSession, loadSession, saveSession } from './lib/session.js';
import TopBar from './components/TopBar.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import ConversationSidebar from './components/ConversationSidebar.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';
import { Spinner } from './components/States.jsx';
import StaffManager from './components/StaffManager.jsx';
import ContactForm from './components/ContactForm.jsx';
import CustomerProfile from './components/CustomerProfile.jsx';
import ForwardModal from './components/ForwardModal.jsx';
import TagManager from './components/TagManager.jsx';
import AdminSettings from './components/AdminSettings.jsx';
import AgentPerformance from './components/AgentPerformance.jsx';
import AutomationSettings from './components/AutomationSettings.jsx';

const PAGE_SIZE = 100;
const MAX_THREAD_PAGE = 200;
const LIST_POLL_MS = 8000;
const THREAD_POLL_MS = 6000;
const SEARCH_DEBOUNCE_MS = 300;

function describeError(error) {
  if (error?.name === 'AbortError') return null;
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

export default function App() {
  const [session, setSession] = useState(() => loadSession());
  const [booting, setBooting] = useState(() => Boolean(loadSession()));

  const [conversations, setConversations] = useState([]);
  const [counts, setCounts] = useState({});
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);

  const [view, setView] = useState('all');
  const [status, setStatus] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  // Module 5: selected tag ids for the inbox filter (ANY match) and the tag
  // catalogue shared by the filter menu, the profile selector and the admin UI.
  const [tagFilter, setTagFilter] = useState([]);
  const [allTags, setAllTags] = useState([]);

  const [selectedId, setSelectedId] = useState(null);
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(null);

  const [staffList, setStaffList] = useState([]);
  const [busy, setBusy] = useState(false);
  const [headerError, setHeaderError] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [staffManagerOpen, setStaffManagerOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  // Module 9: keyword automation + automation logs.
  const [automationOpen, setAutomationOpen] = useState(false);
  // Module 6: bumped whenever an admin edits the Quick Reply library, so an
  // open composer popup reloads it without a page refresh.
  const [quickRepliesVersion, setQuickRepliesVersion] = useState(0);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactError, setContactError] = useState(null);
  const [profileWaId, setProfileWaId] = useState(null);

  // Module 3: reply preview target, forward source message, and the message to
  // scroll to (search results and quoted-reply clicks).
  const [replyTo, setReplyTo] = useState(null);
  const [forwardSource, setForwardSource] = useState(null);
  const [focusMessageId, setFocusMessageId] = useState(null);

  const listAbortRef = useRef(null);
  const listRequestRef = useRef(0);
  const threadAbortRef = useRef(null);
  const threadRequestRef = useRef(0);
  const threadLimitRef = useRef(PAGE_SIZE);

  const staff = session?.staff ?? null;
  const isAdmin = staff?.role === 'admin';

  // Hand the token to the API client. Only the login JWT is ever held here -
  // no API credentials live in the bundle.
  useEffect(() => {
    setTokenReader(() => session?.token ?? null);
  }, [session]);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
    setConversations([]);
    setCounts({});
    setTotal(0);
    setSelectedId(null);
    setThread(null);
    setStaffList([]);
    setSearchInput('');
    setSearch('');
    setStatus('');
    setTagFilter([]);
    setAllTags([]);
    setListError(null);
    setThreadError(null);
    setHeaderError(null);
    setChatOpen(false);
    setProfileWaId(null);
    setTagManagerOpen(false);
    setSettingsOpen(false);
    setPerformanceOpen(false);
    setAutomationOpen(false);
    setReplyTo(null);
    setForwardSource(null);
    setFocusMessageId(null);
  }, []);

  const endSession = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  const handleAuthenticated = useCallback((next) => {
    saveSession(next);
    setSession(next);
  }, []);

  // An expired or revoked token must drop the session instead of leaving a
  // dashboard that silently fails every request.
  const handleAuthFailure = useCallback(
    (error) => {
      if (error instanceof ApiError && error.status === 401) endSession();
    },
    [endSession]
  );

  // Validate whatever was in storage before trusting it.
  useEffect(() => {
    if (!session) {
      setBooting(false);
      return undefined;
    }

    const controller = new AbortController();

    api
      .me(controller.signal)
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        handleAuthFailure(error);
      })
      .finally(() => setBooting(false));

    return () => controller.abort();
  }, [session, handleAuthFailure]);

  // Agents can only ever see their own queue; admins default to the shared one.
  useEffect(() => {
    if (!staff) return;
    setView(staff.role === 'admin' ? 'all' : 'mine');
  }, [staff]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const loadConversations = useCallback(
    async ({ silent = false } = {}) => {
      if (!session) return;

      const requestId = listRequestRef.current + 1;
      listRequestRef.current = requestId;

      listAbortRef.current?.abort();
      const controller = new AbortController();
      listAbortRef.current = controller;

      if (!silent) setListLoading(true);
      setListError(null);

      try {
        const payload = await api.listConversations(
          {
            view,
            status,
            search,
            // Module 5: comma-separated tag ids; the backend combines this
            // with view/status/search in one query, so pagination stays right.
            tags: tagFilter.length > 0 ? tagFilter.join(',') : undefined,
            limit: PAGE_SIZE,
          },
          controller.signal
        );

        if (requestId !== listRequestRef.current) return;

        setConversations(payload.items ?? []);
        setTotal(payload.total ?? 0);
        setCounts(payload.counts ?? {});
      } catch (error) {
        if (error?.name === 'AbortError') return;
        handleAuthFailure(error);
        setListError(describeError(error));
      } finally {
        if (requestId === listRequestRef.current && !silent) setListLoading(false);
      }
    },
    [session, view, status, search, tagFilter, handleAuthFailure]
  );

  // The tag catalogue powers the filter menu, the profile selector and the
  // admin manager. Reloaded on login and whenever a tag is created/renamed.
  const loadTags = useCallback(async () => {
    if (!session) return;
    try {
      const payload = await api.listTags();
      setAllTags(payload.items ?? []);
    } catch (error) {
      handleAuthFailure(error);
    }
  }, [session, handleAuthFailure]);

  useEffect(() => {
    if (!session || booting) return;
    loadTags();
  }, [session, booting, loadTags]);

  /**
   * Called after a tag is added/removed/renamed: the inbox query re-runs (so a
   * conversation that no longer matches the active tag filter disappears) and
   * the catalogue refreshes — no browser reload (§19).
   */
  const handleTagsChanged = useCallback(() => {
    loadConversations({ silent: true });
    loadTags();
  }, [loadConversations, loadTags]);

  const loadThread = useCallback(
    async ({ silent = false } = {}) => {
      if (!session || !selectedId) return;

      const requestId = threadRequestRef.current + 1;
      threadRequestRef.current = requestId;

      threadAbortRef.current?.abort();
      const controller = new AbortController();
      threadAbortRef.current = controller;

      if (!silent) {
        setThreadLoading(true);
        setThreadError(null);
      }

      try {
        const payload = await api.getThread(
          selectedId,
          { limit: threadLimitRef.current, markRead: !silent },
          controller.signal
        );

        if (requestId !== threadRequestRef.current) return;

        const messages = payload.messages ?? [];
        setThread({ conversation: payload.conversation, messages });
        setHasMore(messages.length >= threadLimitRef.current);

        // Only the interactive fetch marks the thread read, so the sidebar
        // badge is cleared in the same pass that asked the backend to do it.
        if (!silent) {
          setConversations((prev) =>
            prev.map((item) =>
              item.id === selectedId ? { ...item, unread_count: 0 } : item
            )
          );
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
        handleAuthFailure(error);
        setThreadError(describeError(error));
      } finally {
        if (requestId === threadRequestRef.current && !silent) setThreadLoading(false);
      }
    },
    [session, selectedId, handleAuthFailure]
  );

  // Fetch on first load and whenever a filter changes.
  useEffect(() => {
    if (!session || booting) return;
    loadConversations();
  }, [session, booting, loadConversations]);

  // Poll the queue so a second staff member's replies and new inbound webhooks
  // show up without a manual refresh. Skipped while the tab is hidden.
  useEffect(() => {
    if (!session || booting) return undefined;

    const timer = setInterval(() => {
      if (!document.hidden) loadConversations({ silent: true });
    }, LIST_POLL_MS);

    return () => clearInterval(timer);
  }, [session, booting, loadConversations]);

  useEffect(() => {
    if (!selectedId) return;

    threadLimitRef.current = PAGE_SIZE;
    setThread(null);
    setHasMore(false);
    setOlderError(null);
    setHeaderError(null);
    setThreadError(null);
    // A pending reply never leaks into a different conversation.
    setReplyTo(null);
  }, [selectedId]);

  useEffect(() => {
    if (!session || booting || !selectedId) return;
    loadThread();
  }, [session, booting, selectedId, loadThread]);

  useEffect(() => {
    if (!session || booting || !selectedId) return undefined;

    const timer = setInterval(() => {
      if (!document.hidden) loadThread({ silent: true });
    }, THREAD_POLL_MS);

    return () => clearInterval(timer);
  }, [session, booting, selectedId, loadThread]);

  useEffect(() => {
    if (!session || !isAdmin) return undefined;

    const controller = new AbortController();

    api
      .listStaff(false, controller.signal)
      .then((payload) => setStaffList(payload.items ?? []))
      .catch((error) => {
        if (error?.name !== 'AbortError') handleAuthFailure(error);
      });

    return () => controller.abort();
  }, [session, isAdmin, handleAuthFailure]);

  const reloadStaff = useCallback(async () => {
    if (!session || !isAdmin) return;
    try {
      const payload = await api.listStaff(false);
      setStaffList(payload.items ?? []);
    } catch (error) {
      handleAuthFailure(error);
    }
  }, [session, isAdmin, handleAuthFailure]);

  const loadOlderMessages = useCallback(async () => {
    if (!selectedId || loadingOlder || !thread?.messages?.length || !hasMore) return;

    setLoadingOlder(true);
    setOlderError(null);

    try {
      const payload = await api.getThread(selectedId, {
        limit: PAGE_SIZE,
        markRead: false,
        before: thread.messages[0].id,
      });

      const older = payload.messages ?? [];
      if (older.length === 0) {
        setHasMore(false);
        return;
      }

      threadLimitRef.current = Math.min(threadLimitRef.current + PAGE_SIZE, MAX_THREAD_PAGE);
      setThread((prev) => (prev ? { ...prev, messages: [...older, ...prev.messages] } : prev));
      setHasMore(older.length >= PAGE_SIZE);
    } catch (error) {
      handleAuthFailure(error);
      setOlderError(describeError(error));
    } finally {
      setLoadingOlder(false);
    }
  }, [selectedId, loadingOlder, thread, hasMore, handleAuthFailure]);

  const runHeaderAction = useCallback(
    async (action) => {
      setBusy(true);
      setHeaderError(null);

      try {
        await action();
        await Promise.all([
          loadConversations({ silent: true }),
          loadThread({ silent: true }),
        ]);
      } catch (error) {
        handleAuthFailure(error);
        setHeaderError(describeError(error));
      } finally {
        setBusy(false);
      }
    },
    [loadConversations, loadThread, handleAuthFailure]
  );

  const handleSelect = useCallback((id) => {
    setSelectedId(id);
    setProfileWaId(null);
    setChatOpen(true);
    setReplyTo(null);
    setFocusMessageId(null);
  }, []);

  const handleClaim = useCallback(() => {
    if (!selectedId) return;
    runHeaderAction(() => api.claimConversation(selectedId));
  }, [selectedId, runHeaderAction]);

  const handleAssign = useCallback(
    (assigneeId) => {
      if (!selectedId) return;
      runHeaderAction(() => api.assignConversation(selectedId, assigneeId));
    },
    [selectedId, runHeaderAction]
  );

  const handleStatusChange = useCallback(
    (nextStatus) => {
      if (!selectedId) return;
      runHeaderAction(() => api.setConversationStatus(selectedId, nextStatus));
    },
    [selectedId, runHeaderAction]
  );

  const handleSend = useCallback(
    async (body) => {
      if (!selectedId || !staff) return;
      const quoted = replyTo;
      const optimistic = {
        id: `pending-${Date.now()}`,
        conversation_id: selectedId,
        direction: 'outbound',
        status: 'queued',
        type: 'text',
        body,
        sent_by_staff_id: staff.id,
        sent_by_staff_name: staff.name,
        created_at: new Date().toISOString(),
        ...(quoted
          ? {
              reply_to_id: quoted.id,
              quoted_body: quoted.body,
              quoted_type: quoted.type,
              quoted_direction: quoted.direction,
              quoted_media_url: quoted.media_url,
              quoted_staff_name: quoted.sent_by_staff_name,
            }
          : {}),
      };
      setThread((prev) => (prev ? { ...prev, messages: [...prev.messages, optimistic] } : prev));
      try { await api.sendMessage(selectedId, body, { replyToId: quoted?.id }); }
      catch (error) {
        handleAuthFailure(error);
        setThread((prev) => prev ? { ...prev, messages: prev.messages.map((m) => m.id === optimistic.id ? { ...m, status: 'failed', error_detail: describeError(error) ?? 'Send failed' } : m) } : prev);
        throw error;
      }
      // Clear only on success: a failed send keeps the reply so it can be retried.
      if (quoted) setReplyTo(null);
      await loadThread({ silent: true });
    }, [selectedId, staff, replyTo, loadThread, handleAuthFailure]
  );

  const handleCancelReply = useCallback(() => setReplyTo(null), []);

  const handleForward = useCallback(
    async (targetConversationId) => {
      if (!forwardSource) return;
      await api.forwardMessage(targetConversationId, forwardSource.id);
      setForwardSource(null);
      const refresh = [loadConversations({ silent: true })];
      if (selectedId) refresh.push(loadThread({ silent: true }));
      await Promise.all(refresh);
    },
    [forwardSource, selectedId, loadConversations, loadThread]
  );

  const handleJumpToMessage = useCallback((messageId) => {
    setFocusMessageId(messageId);
  }, []);

  const handleFocusHandled = useCallback(() => {
    setFocusMessageId(null);
  }, []);

  // Search result: open its conversation (thread reloads via selectedId
  // effect) and target the message, paging older history until it is visible.
  const openSearchResult = useCallback((conversationId, messageId) => {
    setProfileWaId(null);
    setReplyTo(null);
    setChatOpen(true);
    setFocusMessageId(messageId);
    setSelectedId(conversationId);
  }, []);

  // Template Library target: an explicit conversation, the open one, or a raw
  // number that must first become a conversation (reuses it if it already exists).
  const handleTemplate = useCallback(async (payload) => {
    const { conversationId, waId, ...template } = payload ?? {};
    let targetId = conversationId ?? selectedId;

    if (!targetId) {
      if (!waId) throw new Error('Choose a customer to send this template to');
      const created = await api.createConversation(waId);
      targetId = created.id;
    }

    await api.sendTemplate(targetId, template);
    await loadConversations({ silent: true });

    if (targetId === selectedId) {
      setReplyTo(null);
      await loadThread({ silent: true });
    } else {
      setReplyTo(null);
      setProfileWaId(null);
      setSelectedId(targetId);
      setChatOpen(true);
    }
  }, [selectedId, loadThread, loadConversations]);

  const handleMedia = useCallback(async (payload) => {
    if (!selectedId) return;
    await api.sendMedia(selectedId, payload);
    await loadThread({ silent: true });
  }, [selectedId, loadThread]);

  const handleCreateConversation = useCallback(async (rawNumber) => {
    const waId = String(rawNumber ?? '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(waId)) return;
    try {
      const conversation = await api.createConversation(waId);
      await loadConversations({ silent: true });
      setSelectedId(conversation.id);
      setChatOpen(true);
      await loadThread({ silent: true });
    } catch (error) {
      setListError(describeError(error));
    }
  }, [loadConversations, loadThread]);

  const handleSaveContact = useCallback(async ({ name, mobile, notes, tags }) => {
    setContactSaving(true);
    setContactError(null);
    try {
      const result = await api.createContact({ name, mobile, notes, tags });
      await loadConversations({ silent: true });
      if (result?.conversation?.id) {
        setSelectedId(result.conversation.id);
        setChatOpen(true);
        await loadThread({ silent: true });
      }
      setContactOpen(false);
    } catch (error) {
      handleAuthFailure(error);
      setContactError(describeError(error) ?? 'Contact could not be saved');
    } finally {
      setContactSaving(false);
    }
  }, [loadConversations, loadThread, handleAuthFailure]);

  const openContactForm = useCallback(() => {
    setContactError(null);
    setContactOpen(true);
  }, []);

  if (booting) {
    return (
      <div className="boot-screen">
        <Spinner label="Restoring your session…" />
      </div>
    );
  }

  if (!session) {
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="inbox-shell">
      <TopBar
        staff={staff}
        counts={counts}
        refreshing={listLoading}
        onRefresh={() => loadConversations()}
        onLogout={signOut}
        onManageAgents={() => setStaffManagerOpen(true)}
        onManageTags={() => setTagManagerOpen(true)}
        onManageSettings={() => setSettingsOpen(true)}
        onManagePerformance={() => setPerformanceOpen(true)}
        onManageAutomation={() => setAutomationOpen(true)}
      />

      {automationOpen && isAdmin && (
        <AutomationSettings onClose={() => setAutomationOpen(false)} />
      )}

      {performanceOpen && isAdmin && <AgentPerformance onClose={() => setPerformanceOpen(false)} />}

      {settingsOpen && isAdmin && (
        <AdminSettings
          onClose={() => setSettingsOpen(false)}
          onChanged={() => setQuickRepliesVersion((version) => version + 1)}
        />
      )}

      {staffManagerOpen && isAdmin && (
        <StaffManager
          onClose={() => setStaffManagerOpen(false)}
          onChanged={reloadStaff}
        />
      )}

      {tagManagerOpen && isAdmin && (
        <TagManager
          onClose={() => setTagManagerOpen(false)}
          onChanged={handleTagsChanged}
        />
      )}

      <ContactForm
        open={contactOpen}
        saving={contactSaving}
        error={contactError}
        onSave={handleSaveContact}
        onCancel={() => {
          setContactOpen(false);
          setContactError(null);
        }}
      />

      {profileWaId && (
        <CustomerProfile
          waId={profileWaId}
          allTags={allTags}
          onTagsChanged={handleTagsChanged}
          onClose={() => setProfileWaId(null)}
        />
      )}

      {forwardSource && (
        <ForwardModal
          message={forwardSource}
          onForward={handleForward}
          onClose={() => setForwardSource(null)}
        />
      )}

      {listError && (
        <div className="inbox-banner">
          <ErrorBanner
            message={listError}
            onRetry={() => loadConversations()}
            onDismiss={() => setListError(null)}
          />
        </div>
      )}

      <main className={`inbox${chatOpen ? ' chat-open' : ''}`}>
        <ConversationSidebar
          conversations={conversations}
          counts={counts}
          total={total}
          loading={listLoading}
          error={listError}
          isAdmin={isAdmin}
          view={view}
          status={status}
          search={searchInput}
          tags={allTags}
          tagFilter={tagFilter}
          selectedId={selectedId}
          onViewChange={setView}
          onStatusChange={setStatus}
          onSearchChange={setSearchInput}
          onTagFilterChange={setTagFilter}
          onSelect={handleSelect}
          onRetry={() => loadConversations()}
          onCreateConversation={handleCreateConversation}
          onAddContact={openContactForm}
        />

        <ChatPanel
          conversation={thread?.conversation ?? null}
          messages={thread?.messages ?? []}
          loading={threadLoading}
          error={threadError}
          hasMore={hasMore}
          loadingOlder={loadingOlder}
          olderError={olderError}
          busy={busy}
          headerError={headerError}
          staff={staff}
          isAdmin={isAdmin}
          staffList={staffList}
          quickRepliesVersion={quickRepliesVersion}
          replyTo={replyTo}
          focusMessageId={focusMessageId}
          onLoadOlder={loadOlderMessages}
          onRetry={() => loadThread()}
          onRetryOlder={loadOlderMessages}
          onClaim={handleClaim}
          onAssign={handleAssign}
          onStatusChange={handleStatusChange}
          onOpenProfile={() => {
            const waId = thread?.conversation?.contact_wa_id;
            if (waId) setProfileWaId(waId);
          }}
          onOpenSearchResult={openSearchResult}
          onSend={handleSend}
          onSendTemplate={handleTemplate}
          onSendMedia={handleMedia}
          onReply={setReplyTo}
          onCancelReply={handleCancelReply}
          onForward={setForwardSource}
          onJumpToMessage={handleJumpToMessage}
          onFocusHandled={handleFocusHandled}
          onBack={() => setChatOpen(false)}
        />
      </main>
    </div>
  );
}