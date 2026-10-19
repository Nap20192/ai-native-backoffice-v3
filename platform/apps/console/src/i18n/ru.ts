import type { Messages } from "./types";

export const ru: Messages = {
  common: {
    loading: "Загрузка…",
    cancel: "Отмена",
    create: "Создать",
    edit: "Изменить",
    save: "Сохранить",
    saveChanges: "Сохранить изменения",
    saving: "Сохранение…",
    creating: "Создание…",
    rename: "Переименовать",
    reset: "Сбросить",
    delete: "Удалить",
    archive: "В архив",
    unarchive: "Вернуть из архива",
    actions: "Действия",
    status: "Статус",
    name: "Название",
    description: "Описание",
    created: "Создано",
    id: "ID",
    model: "Модель",
    active: "Активен",
    archived: "В архиве",
    all: "Все",
    copied: "Скопировано",
    viewAll: "Показать все",
    loadingMore: "Загружаем ещё…",
    columns: "Столбцы",
    visibleColumns: "Видимые столбцы",
    nameRequired: "Укажите название",
  },

  nav: {
    overview: "Обзор",
    managedAgents: "Управляемые агенты",
    dashboard: "Сводка",
    agents: "Агенты",
    sessions: "Сессии",
    deployments: "Деплойменты",
    files: "Файлы",
    evalRuns: "Запуски оценки",
    infrastructure: "Инфраструктура",
    environments: "Окружения",
    credentialVaults: "Хранилища секретов",
    configuration: "Конфигурация",
    skills: "Навыки",
    memoryStores: "Хранилища памяти",
    modelCards: "Карточки моделей",
    apiKeys: "API-ключи",
    members: "Участники",
  },

  shell: {
    workspaceNavigation: "Навигация по рабочему пространству",
    sections: "Разделы консоли",
    breadcrumb: "Путь по разделам",
    showSidebar: "Показать меню",
    closeSidebar: "Закрыть меню",
    resizeSidebar: "Изменить ширину меню",
    loadingSession: "Загрузка сессии",
  },

  login: {
    minChars: "Не менее 8 символов",
    passwordResetSuccess: "Пароль изменён. Войдите в систему.",
    authFailed: "Не удалось войти",
  },

  dashboard: {
    intro: "Сводка рабочего пространства и короткий путь к первому запуску агента.",
    recentSessions: "Последние сессии",
    visitSessionsPage: "Страница сессий",
    title: "Название",
    agent: "Агент",
    untitled: "Без названия",
  },

  command: {
    title: "Командная палитра",
    description: "Переход на любую страницу консоли.",
    jumpTo: "Перейти к…",
    noMatches: "Ничего не найдено.",
    recent: "Недавние",
    actions: "Действия",
    navigate: "Переходы",
    search: "Поиск",
  },

  profile: {
    accountMenu: "Меню учётной записи",
    theme: "Тема",
    light: "Светлая",
    dark: "Тёмная",
    system: "Системная",
    signOut: "Выйти",
    switchWorkspace: "Сменить рабочее пространство",
    createWorkspace: "Создать рабочее пространство…",
    createWorkspaceDesc:
      "Рабочее пространство изолирует агентов, сессии и хранилища секретов. Вы станете владельцем нового пространства.",
    workspaceName: "Название",
    workspacePlaceholder: "Например, Продуктовая среда",
    creating: "Создание…",
    account: "Учётная запись",
    roleOwner: "Владелец",
    roleAdmin: "Администратор",
    roleMember: "Участник",
  },

  agents: {
    newAgent: "Новый агент",
    editAgent: "Изменить",
    newAgentTitle: "Новый агент",
    editAgentTitle: "Изменение агента",
    createAgent: "Создать агента",
    editingVersion: "Редактирование v{version}",
    searchAgents: "Поиск агентов…",
    noMatchingAgents: "Агенты не найдены",
    noAgentsYet: "Агентов пока нет",
    createFirstAgent: "Создайте первого агента, чтобы начать.",
    getStartedGuide: "Руководство по быстрому старту",
    tryDifferentSearch: "Измените поисковый запрос.",
  },

  sessions: {
    newSession: "Новая сессия",
    searchSessions: "Поиск сессий…",
    noMatchingSessions: "Сессии не найдены",
    noSessionsYet: "Сессий пока нет",
    untitledSession: "Сессия без названия",
  },

  vaults: {
    newVault: "Новое хранилище",
    searchVaults: "Поиск хранилищ…",
    noMatchingVaults: "Хранилища не найдены",
    noVaultsYet: "Хранилищ пока нет",
    renameVault: "Переименовать хранилище",
    editCredential: "Изменить учётные данные",
    displayName: "Отображаемое имя",
    newTokenOptional: "Новый токен (необязательно)",
    leaveBlankKeepToken: "Оставьте пустым, чтобы сохранить текущий токен",
    oauthEditHint:
      "У учётных данных OAuth токены сохраняются, можно только переименовать. Чтобы обновить OAuth, подключите их заново через «Добавить».",
  },

  environments: {
    newEnvironment: "Новое окружение",
    searchEnvironments: "Поиск окружений…",
    noMatchingEnvironments: "Окружения не найдены",
    noEnvironmentsYet: "Окружений пока нет",
  },

  files: {
    noFilesYet: "Файлов пока нет",
  },

  skills: {
    newSkill: "Новый навык",
    searchSkills: "Поиск навыков…",
    noMatchingSkills: "Навыки не найдены",
    noSkillsYet: "Навыков пока нет",
  },

  modelCards: {
    newModelCard: "Новая карточка модели",
    searchModelCards: "Поиск карточек моделей…",
    noMatchingModelCards: "Карточки моделей не найдены",
    noModelCardsYet: "Карточек моделей пока нет",
  },

  apiKeys: {
    newApiKey: "Новый API-ключ",
    noApiKeysYet: "API-ключей пока нет",
    revokeKey: "Отозвать",
    untitledKey: "Ключ без названия",
  },

  evals: {
    searchEvalRuns: "Поиск запусков оценки…",
    noMatchingEvalRuns: "Запуски оценки не найдены",
    noEvalRunsYet: "Запусков оценки пока нет",
  },

  memory: {
    newMemoryStore: "Новое хранилище памяти",
    searchMemoryStores: "Поиск хранилищ памяти…",
    noMatchingMemoryStores: "Хранилища памяти не найдены",
    noMemoryStoresYet: "Хранилищ памяти пока нет",
    mountPathHint: "Путь монтирования будет",
    settingsArchiveHint:
      "Чтобы заархивировать или удалить хранилище, используйте действия в шапке страницы.",
  },
};
