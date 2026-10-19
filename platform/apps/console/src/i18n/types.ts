/**
 * Interface strings shared by several console pages, grouped by area.
 * The console is Russian only: `ru.ts` is the single dictionary.
 */
export interface Messages {
  // Common / shared
  common: {
    loading: string;
    cancel: string;
    create: string;
    edit: string;
    save: string;
    saveChanges: string;
    saving: string;
    creating: string;
    rename: string;
    reset: string;
    delete: string;
    archive: string;
    unarchive: string;
    actions: string;
    status: string;
    name: string;
    description: string;
    created: string;
    id: string;
    model: string;
    active: string;
    archived: string;
    all: string;
    copied: string;
    viewAll: string;
    loadingMore: string;
    columns: string;
    visibleColumns: string;
    nameRequired: string;
  };

  // Sidebar navigation
  nav: {
    overview: string;
    managedAgents: string;
    dashboard: string;
    agents: string;
    sessions: string;
    deployments: string;
    files: string;
    evalRuns: string;
    infrastructure: string;
    environments: string;
    credentialVaults: string;
    configuration: string;
    skills: string;
    memoryStores: string;
    modelCards: string;
    apiKeys: string;
    members: string;
  };

  // Shell chrome: aria-labels of the sidebar, top bar and loader
  shell: {
    workspaceNavigation: string;
    sections: string;
    breadcrumb: string;
    showSidebar: string;
    closeSidebar: string;
    resizeSidebar: string;
    loadingSession: string;
  };

  // Login page
  login: {
    minChars: string;
    passwordResetSuccess: string;
    authFailed: string;
  };

  // Dashboard
  dashboard: {
    intro: string;
    recentSessions: string;
    visitSessionsPage: string;
    title: string;
    agent: string;
    untitled: string;
  };

  // Command palette
  command: {
    title: string;
    description: string;
    jumpTo: string;
    noMatches: string;
    recent: string;
    actions: string;
    navigate: string;
    search: string;
  };

  // User profile menu
  profile: {
    accountMenu: string;
    theme: string;
    light: string;
    dark: string;
    system: string;
    signOut: string;
    switchWorkspace: string;
    createWorkspace: string;
    createWorkspaceDesc: string;
    workspaceName: string;
    workspacePlaceholder: string;
    creating: string;
    account: string;
    roleOwner: string;
    roleAdmin: string;
    roleMember: string;
  };

  // Agents list
  agents: {
    newAgent: string;
    editAgent: string;
    newAgentTitle: string;
    editAgentTitle: string;
    createAgent: string;
    editingVersion: string;
    searchAgents: string;
    noMatchingAgents: string;
    noAgentsYet: string;
    createFirstAgent: string;
    getStartedGuide: string;
    tryDifferentSearch: string;
  };

  // Sessions list
  sessions: {
    newSession: string;
    searchSessions: string;
    noMatchingSessions: string;
    noSessionsYet: string;
    untitledSession: string;
  };

  // Vaults list
  vaults: {
    newVault: string;
    searchVaults: string;
    noMatchingVaults: string;
    noVaultsYet: string;
    renameVault: string;
    editCredential: string;
    displayName: string;
    newTokenOptional: string;
    leaveBlankKeepToken: string;
    oauthEditHint: string;
  };

  // Environments list
  environments: {
    newEnvironment: string;
    searchEnvironments: string;
    noMatchingEnvironments: string;
    noEnvironmentsYet: string;
  };

  // Files list
  files: {
    noFilesYet: string;
  };

  // Skills list
  skills: {
    newSkill: string;
    searchSkills: string;
    noMatchingSkills: string;
    noSkillsYet: string;
  };

  // Model cards list
  modelCards: {
    newModelCard: string;
    searchModelCards: string;
    noMatchingModelCards: string;
    noModelCardsYet: string;
  };

  // API keys list
  apiKeys: {
    newApiKey: string;
    noApiKeysYet: string;
    revokeKey: string;
    untitledKey: string;
  };

  // Eval runs
  evals: {
    searchEvalRuns: string;
    noMatchingEvalRuns: string;
    noEvalRunsYet: string;
  };

  // Memory stores
  memory: {
    newMemoryStore: string;
    searchMemoryStores: string;
    noMatchingMemoryStores: string;
    noMemoryStoresYet: string;
    mountPathHint: string;
    settingsArchiveHint: string;
  };
}
