import type { PluginTheme } from "@getpaseo/plugin";
import {
  useAgent,
  useRpc,
  useSettings,
  useWorkspace,
  type PluginAgentPanelProps,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES,
  type TaskPriority,
  type TaskSort,
  type TaskStatus,
} from "../shared/constants";
import {
  boardMoveRpc,
  getAgentTasksRpc,
  listFoldersRpc,
  listLabelsRpc,
  listProjectsRpc,
  listTasksRpc,
  seedDemoRpc,
  sidebarOpenTaskCountRpc,
  sidebarSummaryRpc,
  type Label,
  type Project,
  type Task,
} from "../shared/contract";
import { tasksSettings } from "../shared/settings";
import {
  LabelPill,
  PriorityBadge,
  PriorityIcon,
  ProjectDot,
  StatusBadge,
  StatusIcon,
} from "./badges";
import { TaskDetailView } from "./detail-view";
import { ManageModal, NewTaskModal } from "./modals";

function TasksBoardAndListShell({
  theme,
  compact,
  initialTaskKey,
  initialProjectId,
  linkedPaseoProjectId,
  openAgent,
  openWorkspace,
}: {
  theme: PluginTheme;
  compact: boolean;
  initialTaskKey?: string | null;
  initialProjectId?: string | null;
  linkedPaseoProjectId?: string | null;
  openAgent?: (input: { readonly agentId: string }) => void;
  openWorkspace?: (input: { readonly workspaceId: string }) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useSettings(tasksSettings);

  const listProjects = useRpc(listProjectsRpc);
  const listFolders = useRpc(listFoldersRpc);
  const listTasks = useRpc(listTasksRpc);
  const listLabels = useRpc(listLabelsRpc);
  const boardMove = useRpc(boardMoveRpc);
  const sidebarSummary = useRpc(sidebarSummaryRpc);
  const seedDemo = useRpc(seedDemoRpc);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId ?? null,
  );
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(
    initialTaskKey ?? null,
  );
  const [viewMode, setViewMode] = useState<"board" | "list">("board");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | null>(
    null,
  );
  const [sortBy, setSortBy] = useState<TaskSort>("manual");
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<TaskStatus>>(
    new Set(),
  );

  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskDefaultStatus, setNewTaskDefaultStatus] =
    useState<TaskStatus>("todo");
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTab, setManageTab] = useState<"projects" | "presets">(
    "projects",
  );
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    if (settings.status === "ready") {
      setViewMode(settings.values.defaultView);
    }
  }, [settings.status]);

  useEffect(() => {
    if (initialTaskKey !== undefined) {
      setSelectedTaskKey(initialTaskKey || null);
    }
  }, [initialTaskKey]);

  useEffect(() => {
    if (initialProjectId !== undefined) {
      setSelectedProjectId(initialProjectId || null);
    }
  }, [initialProjectId]);

  const projectsQuery = useQuery({
    queryKey: ["tasks", "projects"],
    queryFn: () => listProjects({}),
    refetchInterval: 4000,
  });
  const foldersQuery = useQuery({
    queryKey: ["tasks", "folders"],
    queryFn: () => listFolders({}),
    refetchInterval: 5000,
  });
  const summaryQuery = useQuery({
    queryKey: ["tasks", "sidebarSummary"],
    queryFn: () => sidebarSummary({}),
    refetchInterval: 4000,
  });

  const projects = projectsQuery.data?.projects ?? [];
  const folders = foldersQuery.data?.folders ?? [];
  const summaries = summaryQuery.data?.projects ?? [];
  const summaryByProject = useMemo(
    () => new Map(summaries.map((s) => [s.projectId, s])),
    [summaries],
  );

  // Auto-select tracker project linked to workspace's Paseo project
  useEffect(() => {
    if (!selectedProjectId && linkedPaseoProjectId && projects.length > 0) {
      const match = projects.find(
        (p) => p.linkedBbProjectId === linkedPaseoProjectId,
      );
      if (match) setSelectedProjectId(match.id);
    }
  }, [linkedPaseoProjectId, projects, selectedProjectId]);

  const tasksQuery = useQuery({
    queryKey: [
      "tasks",
      "list",
      selectedProjectId,
      activeOnly,
      priorityFilter,
      searchQuery,
      sortBy,
    ],
    queryFn: () =>
      listTasks({
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
        ...(priorityFilter ? { priorities: [priorityFilter] } : {}),
        activeOnly,
        parentTaskId: null,
        ...(searchQuery.trim() ? { search: searchQuery.trim() } : {}),
        sort: sortBy,
        limit: 300,
      }),
    refetchInterval: 3000,
  });

  const allLabelsQuery = useQuery({
    queryKey: [
      "tasks",
      "allLabels",
      projects.map((p) => p.id).join(","),
    ],
    queryFn: async () => {
      const map = new Map<string, Label>();
      await Promise.all(
        projects.map(async (p) => {
          const res = await listLabels({ projectId: p.id });
          for (const l of res.labels) map.set(l.id, l);
        }),
      );
      return map;
    },
    enabled: projects.length > 0,
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const labelById = allLabelsQuery.data ?? new Map<string, Label>();
  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );
  const currentProject = selectedProjectId
    ? projectById.get(selectedProjectId) ?? null
    : null;

  const showCompleted =
    settings.status === "ready" ? settings.values.showCompletedInBoard : true;
  const visibleStatuses = useMemo(
    () =>
      showCompleted
        ? TASK_STATUSES
        : TASK_STATUSES.filter((s) => s !== "done" && s !== "canceled"),
    [showCompleted],
  );

  const tasksByStatus = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const s of TASK_STATUSES) map.set(s, []);
    for (const t of tasks) {
      map.get(t.status)?.push(t);
    }
    return map;
  }, [tasks]);

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };

  async function handleMoveStatus(task: Task, targetStatus: TaskStatus) {
    try {
      const res = await boardMove({
        taskId: task.id,
        status: targetStatus,
        authorName: "You",
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      invalidateAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSeedDemo() {
    setSeeding(true);
    try {
      const res = await seedDemo({
        ...(linkedPaseoProjectId
          ? { linkedProjectId: linkedPaseoProjectId }
          : {}),
      });
      invalidateAll();
      toast.show(
        `Created ${res.projectsCreated} sample projects & ${res.tasksCreated} tasks`,
        { variant: "success" },
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSeeding(false);
    }
  }

  // On compact layouts, when a task is open, show full-screen detail with a back bar
  if (compact && selectedTaskKey) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <TaskDetailView
          taskKey={selectedTaskKey}
          theme={theme}
          compact={compact}
          onSelectTaskKey={setSelectedTaskKey}
          onClose={() => setSelectedTaskKey(null)}
          onOpenManagePresets={() => {
            setManageTab("presets");
            setManageOpen(true);
          }}
          openAgent={openAgent}
          openWorkspace={openWorkspace}
        />
        <ManageModal
          open={manageOpen}
          onOpenChange={setManageOpen}
          initialTab={manageTab}
          theme={theme}
        />
      </View>
    );
  }

  return (
    <View
      style={{
        flex: 1,
        flexDirection: compact ? "column" : "row",
        backgroundColor: theme.colors.surface0,
      }}
    >
      {/* Left Navigation Rail (Wide Desktop) */}
      {!compact ? (
        <View
          style={{
            width: 220,
            borderRightWidth: 1,
            borderRightColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            padding: 12,
            gap: 10,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 4,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
              <Icon name="ListTodo" size={16} color={theme.colors.accent} />
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 14,
                  fontWeight: "700",
                }}
              >
                Tasks
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New task"
              onPress={() => {
                setNewTaskDefaultStatus("todo");
                setNewTaskOpen(true);
              }}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: theme.colors.accent,
              }}
            >
              <Text
                style={{
                  color: theme.colors.accentForeground,
                  fontSize: 11,
                  fontWeight: "700",
                }}
              >
                + Task
              </Text>
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 4 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setSelectedProjectId(null);
                setActiveOnly(false);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor:
                  selectedProjectId === null && !activeOnly
                    ? theme.colors.surface2
                    : "transparent",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon
                  name="Layers"
                  size={14}
                  color={theme.colors.foreground}
                />
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight:
                      selectedProjectId === null && !activeOnly ? "700" : "500",
                  }}
                >
                  All Tasks
                </Text>
              </View>
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 11,
                }}
              >
                {summaries.reduce((acc, s) => acc + s.taskCount, 0)}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => setActiveOnly((prev) => !prev)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: activeOnly
                  ? theme.colors.surface2
                  : "transparent",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon name="Play" size={14} color="#f59e0b" />
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: activeOnly ? "700" : "500",
                  }}
                >
                  Active Agents
                </Text>
              </View>
              <Text style={{ color: "#f59e0b", fontSize: 11, fontWeight: "700" }}>
                {summaries.reduce((acc, s) => acc + s.activeAgentCount, 0)}
              </Text>
            </Pressable>

            <View
              style={{
                height: 1,
                backgroundColor: theme.colors.border,
                marginVertical: 6,
              }}
            />

            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 10,
                fontWeight: "700",
                paddingHorizontal: 8,
                marginBottom: 2,
              }}
            >
              PROJECTS
            </Text>

            {folders.map((folder) => {
              const folderProjects = projects.filter(
                (p) => p.folderId === folder.id,
              );
              return (
                <View key={folder.id} style={{ gap: 2 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                    }}
                  >
                    <Icon
                      name="Folder"
                      size={12}
                      color={theme.colors.foregroundMuted}
                    />
                    <Text
                      style={{
                        color: theme.colors.foregroundMuted,
                        fontSize: 11,
                        fontWeight: "600",
                      }}
                    >
                      {folder.name}
                    </Text>
                  </View>
                  {folderProjects.map((project) => {
                    const active = selectedProjectId === project.id;
                    const sum = summaryByProject.get(project.id);
                    return (
                      <Pressable
                        key={project.id}
                        accessibilityRole="button"
                        onPress={() => setSelectedProjectId(project.id)}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "space-between",
                          paddingLeft: 18,
                          paddingRight: 10,
                          paddingVertical: 6,
                          borderRadius: 8,
                          backgroundColor: active
                            ? theme.colors.surface2
                            : "transparent",
                        }}
                      >
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 7,
                            flex: 1,
                          }}
                        >
                          <ProjectDot color={project.color} size={8} />
                          <Text
                            numberOfLines={1}
                            style={{
                              color: theme.colors.foreground,
                              fontSize: 12,
                              fontWeight: active ? "700" : "500",
                              flex: 1,
                            }}
                          >
                            {project.name}
                          </Text>
                        </View>
                        <Text
                          style={{
                            color: theme.colors.foregroundMuted,
                            fontSize: 11,
                          }}
                        >
                          {sum?.taskCount ?? 0}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              );
            })}

            {projects
              .filter((p) => p.folderId === null)
              .map((project) => {
                const active = selectedProjectId === project.id;
                const sum = summaryByProject.get(project.id);
                return (
                  <Pressable
                    key={project.id}
                    accessibilityRole="button"
                    onPress={() => setSelectedProjectId(project.id)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      borderRadius: 8,
                      backgroundColor: active
                        ? theme.colors.surface2
                        : "transparent",
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        flex: 1,
                      }}
                    >
                      <ProjectDot color={project.color} size={8} />
                      <Text
                        numberOfLines={1}
                        style={{
                          color: theme.colors.foreground,
                          fontSize: 12,
                          fontWeight: active ? "700" : "500",
                          flex: 1,
                        }}
                      >
                        {project.name}
                      </Text>
                    </View>
                    <Text
                      style={{
                        color: theme.colors.foregroundMuted,
                        fontSize: 11,
                      }}
                    >
                      {sum?.taskCount ?? 0}
                    </Text>
                  </Pressable>
                );
              })}
          </ScrollView>

          <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setManageTab("projects");
                setManageOpen(true);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Icon name="Folder" size={13} color={theme.colors.foreground} />
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                Projects & Labels
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setManageTab("presets");
                setManageOpen(true);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Icon name="Settings" size={13} color={theme.colors.foreground} />
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                Agent Presets
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Main Content Area */}
      <View style={{ flex: 1, minWidth: 0 }}>
        {/* Top Toolbar */}
        <View
          style={{
            paddingHorizontal: compact ? 12 : 18,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 10,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {currentProject ? (
                <ProjectDot color={currentProject.color} size={10} />
              ) : null}
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: compact ? 16 : 18,
                  fontWeight: "700",
                }}
              >
                {currentProject
                  ? `${currentProject.prefix} · ${currentProject.name}`
                  : "All Tasks"}
              </Text>
              {currentProject?.linkedBbProjectId ? (
                <View
                  style={{
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 999,
                    backgroundColor: theme.colors.surface2,
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 10,
                      fontWeight: "600",
                    }}
                  >
                    Linked to Paseo Project
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {/* View Switcher */}
              <View
                style={{
                  flexDirection: "row",
                  padding: 3,
                  borderRadius: 8,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setViewMode("board")}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 6,
                    backgroundColor:
                      viewMode === "board"
                        ? theme.colors.surface0
                        : "transparent",
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.foreground,
                      fontSize: 12,
                      fontWeight: viewMode === "board" ? "700" : "500",
                    }}
                  >
                    Board
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setViewMode("list")}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 6,
                    backgroundColor:
                      viewMode === "list"
                        ? theme.colors.surface0
                        : "transparent",
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.foreground,
                      fontSize: 12,
                      fontWeight: viewMode === "list" ? "700" : "500",
                    }}
                  >
                    List
                  </Text>
                </Pressable>
              </View>

              {compact ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setManageTab("projects");
                    setManageOpen(true);
                  }}
                  style={{
                    paddingHorizontal: 9,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface2,
                  }}
                >
                  <Icon
                    name="Settings"
                    size={14}
                    color={theme.colors.foreground}
                  />
                </Pressable>
              ) : null}

              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setNewTaskDefaultStatus("todo");
                  setNewTaskOpen(true);
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Icon
                  name="Plus"
                  size={13}
                  color={theme.colors.accentForeground}
                />
                <Text
                  style={{
                    color: theme.colors.accentForeground,
                    fontSize: 12,
                    fontWeight: "700",
                  }}
                >
                  New Task
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Compact project chips */}
          {compact && projects.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6 }}
            >
              <Pressable
                accessibilityRole="button"
                onPress={() => setSelectedProjectId(null)}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 999,
                  backgroundColor:
                    selectedProjectId === null
                      ? theme.colors.accent
                      : theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color:
                      selectedProjectId === null
                        ? theme.colors.accentForeground
                        : theme.colors.foreground,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  All
                </Text>
              </Pressable>
              {projects.map((p) => {
                const active = selectedProjectId === p.id;
                return (
                  <Pressable
                    key={p.id}
                    accessibilityRole="button"
                    onPress={() => setSelectedProjectId(p.id)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                      paddingHorizontal: 9,
                      paddingVertical: 5,
                      borderRadius: 999,
                      backgroundColor: active
                        ? theme.colors.accent
                        : theme.colors.surface2,
                    }}
                  >
                    <ProjectDot color={p.color} size={7} />
                    <Text
                      style={{
                        color: active
                          ? theme.colors.accentForeground
                          : theme.colors.foreground,
                        fontSize: 11,
                        fontWeight: "600",
                      }}
                    >
                      {p.prefix}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}

          {/* Filter & Search Bar */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                minWidth: 180,
                flex: 1,
              }}
            >
              <Icon
                name="Search"
                size={13}
                color={theme.colors.foregroundMuted}
              />
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Filter by key (TASKS-1), title, or description…"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  flex: 1,
                  color: theme.colors.foreground,
                  fontSize: 12,
                  paddingVertical: 2,
                }}
              />
              {searchQuery ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSearchQuery("")}
                >
                  <Icon
                    name="X"
                    size={12}
                    color={theme.colors.foregroundMuted}
                  />
                </Pressable>
              ) : null}
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {TASK_PRIORITIES.filter((p) => p !== "none").map((p) => {
                const active = priorityFilter === p;
                return (
                  <Pressable
                    key={p}
                    accessibilityRole="button"
                    onPress={() =>
                      setPriorityFilter((prev) => (prev === p ? null : p))
                    }
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 5,
                      borderRadius: 6,
                      backgroundColor: active
                        ? theme.colors.accent
                        : theme.colors.surface2,
                    }}
                  >
                    <Text
                      style={{
                        color: active
                          ? theme.colors.accentForeground
                          : theme.colors.foreground,
                        fontSize: 11,
                        fontWeight: active ? "700" : "500",
                      }}
                    >
                      {PRIORITY_LABELS[p]}
                    </Text>
                  </Pressable>
                );
              })}

              {TASK_SORTS.map((s) => {
                const active = sortBy === s;
                return (
                  <Pressable
                    key={s}
                    accessibilityRole="button"
                    onPress={() => setSortBy(s)}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 5,
                      borderRadius: 6,
                      borderWidth: 1,
                      borderColor: active
                        ? theme.colors.accent
                        : theme.colors.border,
                      backgroundColor: theme.colors.surface2,
                    }}
                  >
                    <Text
                      style={{
                        color: theme.colors.foreground,
                        fontSize: 11,
                        fontWeight: active ? "700" : "400",
                      }}
                    >
                      Sort: {s}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>

        {/* Empty State when no projects exist */}
        {projects.length === 0 && !projectsQuery.isLoading ? (
          <View
            style={{
              flex: 1,
              padding: 32,
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
            }}
          >
            <Icon name="ListTodo" size={36} color={theme.colors.accent} />
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 18,
                fontWeight: "700",
              }}
            >
              Welcome to Paseo Tasks
            </Text>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 13,
                textAlign: "center",
                maxWidth: 440,
                lineHeight: 20,
              }}
            >
              Create a tracker project and link it to a Paseo project to plan
              work, dispatch tasks to worker agents using presets, and steer
              agents from task comments.
            </Text>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                accessibilityRole="button"
                disabled={seeding}
                onPress={() => void handleSeedDemo()}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                  borderRadius: 8,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.accentForeground,
                    fontSize: 13,
                    fontWeight: "700",
                  }}
                >
                  {seeding ? "Seeding…" : "Seed Sample Projects & Tasks"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setManageTab("projects");
                  setManageOpen(true);
                }}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                  borderRadius: 8,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  Create Project
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          /* Board or List + Optional Split Detail Pane */
          <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              {viewMode === "board" ? (
                <ScrollView
                  horizontal
                  style={{ flex: 1 }}
                  contentContainerStyle={{
                    padding: compact ? 12 : 16,
                    gap: 12,
                  }}
                >
                  {visibleStatuses.map((status, statusIdx) => {
                    const columnTasks = tasksByStatus.get(status) ?? [];
                    const prevStatus = visibleStatuses[statusIdx - 1];
                    const nextStatus = visibleStatuses[statusIdx + 1];

                    return (
                      <View
                        key={status}
                        style={{
                          width: compact ? 260 : 285,
                          borderRadius: 12,
                          backgroundColor: theme.colors.surface1,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          padding: 10,
                          gap: 8,
                        }}
                      >
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            paddingHorizontal: 4,
                            paddingVertical: 2,
                          }}
                        >
                          <View
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <StatusIcon
                              status={status}
                              theme={theme}
                              size={14}
                            />
                            <Text
                              style={{
                                color: theme.colors.foreground,
                                fontSize: 13,
                                fontWeight: "700",
                              }}
                            >
                              {STATUS_LABELS[status]}
                            </Text>
                            <Text
                              style={{
                                color: theme.colors.foregroundMuted,
                                fontSize: 12,
                              }}
                            >
                              {columnTasks.length}
                            </Text>
                          </View>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Add task to ${STATUS_LABELS[status]}`}
                            onPress={() => {
                              setNewTaskDefaultStatus(status);
                              setNewTaskOpen(true);
                            }}
                            style={{
                              padding: 4,
                              borderRadius: 6,
                              backgroundColor: theme.colors.surface2,
                            }}
                          >
                            <Icon
                              name="Plus"
                              size={12}
                              color={theme.colors.foreground}
                            />
                          </Pressable>
                        </View>

                        <ScrollView
                          style={{ flex: 1 }}
                          contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
                        >
                          {columnTasks.map((task) => {
                            const selected = selectedTaskKey === task.key;
                            const proj = projectById.get(task.projectId);
                            const taskLabels = task.labelIds
                              .map((id) => labelById.get(id))
                              .filter((l): l is Label => Boolean(l));

                            return (
                              <Pressable
                                key={task.id}
                                accessibilityRole="button"
                                onPress={() => setSelectedTaskKey(task.key)}
                                style={{
                                  padding: 11,
                                  borderRadius: 10,
                                  backgroundColor: theme.colors.surface0,
                                  borderWidth: 1,
                                  borderColor: selected
                                    ? theme.colors.accent
                                    : theme.colors.border,
                                  gap: 7,
                                }}
                              >
                                <View
                                  style={{
                                    flexDirection: "row",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                  }}
                                >
                                  <View
                                    style={{
                                      flexDirection: "row",
                                      alignItems: "center",
                                      gap: 6,
                                    }}
                                  >
                                    {proj ? (
                                      <ProjectDot
                                        color={proj.color}
                                        size={7}
                                      />
                                    ) : null}
                                    <Text
                                      style={{
                                        color: theme.colors.foregroundMuted,
                                        fontSize: 11,
                                        fontWeight: "700",
                                      }}
                                    >
                                      {task.key}
                                    </Text>
                                    <PriorityIcon
                                      priority={task.priority}
                                      theme={theme}
                                      size={12}
                                    />
                                  </View>

                                  <View
                                    style={{
                                      flexDirection: "row",
                                      alignItems: "center",
                                      gap: 4,
                                    }}
                                  >
                                    {prevStatus ? (
                                      <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`Move ${task.key} to ${STATUS_LABELS[prevStatus]}`}
                                        onPress={() =>
                                          void handleMoveStatus(
                                            task,
                                            prevStatus,
                                          )
                                        }
                                        style={{
                                          paddingHorizontal: 5,
                                          paddingVertical: 2,
                                          borderRadius: 4,
                                          backgroundColor:
                                            theme.colors.surface2,
                                        }}
                                      >
                                        <Text
                                          style={{
                                            color:
                                              theme.colors.foregroundMuted,
                                            fontSize: 10,
                                          }}
                                        >
                                          ←
                                        </Text>
                                      </Pressable>
                                    ) : null}
                                    {nextStatus ? (
                                      <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel={`Move ${task.key} to ${STATUS_LABELS[nextStatus]}`}
                                        onPress={() =>
                                          void handleMoveStatus(
                                            task,
                                            nextStatus,
                                          )
                                        }
                                        style={{
                                          paddingHorizontal: 5,
                                          paddingVertical: 2,
                                          borderRadius: 4,
                                          backgroundColor:
                                            theme.colors.surface2,
                                        }}
                                      >
                                        <Text
                                          style={{
                                            color:
                                              theme.colors.foregroundMuted,
                                            fontSize: 10,
                                          }}
                                        >
                                          →
                                        </Text>
                                      </Pressable>
                                    ) : null}
                                  </View>
                                </View>

                                <Text
                                  numberOfLines={2}
                                  style={{
                                    color: theme.colors.foreground,
                                    fontSize: 13,
                                    fontWeight: "600",
                                    lineHeight: 18,
                                  }}
                                >
                                  {task.title}
                                </Text>

                                {taskLabels.length > 0 || task.dueDate ? (
                                  <View
                                    style={{
                                      flexDirection: "row",
                                      flexWrap: "wrap",
                                      alignItems: "center",
                                      gap: 5,
                                    }}
                                  >
                                    {taskLabels.map((l) => (
                                      <LabelPill
                                        key={l.id}
                                        name={l.name}
                                        color={l.color}
                                        theme={theme}
                                      />
                                    ))}
                                    {task.dueDate ? (
                                      <View
                                        style={{
                                          flexDirection: "row",
                                          alignItems: "center",
                                          gap: 4,
                                          paddingHorizontal: 6,
                                          paddingVertical: 2,
                                          borderRadius: 6,
                                          backgroundColor:
                                            theme.colors.surface2,
                                        }}
                                      >
                                        <Icon
                                          name="Calendar"
                                          size={10}
                                          color={theme.colors.foregroundMuted}
                                        />
                                        <Text
                                          style={{
                                            color:
                                              theme.colors.foregroundMuted,
                                            fontSize: 10,
                                          }}
                                        >
                                          {task.dueDate}
                                        </Text>
                                      </View>
                                    ) : null}
                                  </View>
                                ) : null}
                              </Pressable>
                            );
                          })}
                        </ScrollView>
                      </View>
                    );
                  })}
                </ScrollView>
              ) : (
                /* Grouped List View */
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{
                    padding: compact ? 12 : 18,
                    gap: 14,
                  }}
                >
                  {(
                    [
                      "in_progress",
                      "in_review",
                      "todo",
                      "backlog",
                      "done",
                      "canceled",
                    ] as const
                  ).map((status) => {
                    const groupTasks = tasksByStatus.get(status) ?? [];
                    const collapsed = collapsedStatuses.has(status);
                    return (
                      <View
                        key={status}
                        style={{
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.surface1,
                          overflow: "hidden",
                        }}
                      >
                        <Pressable
                          accessibilityRole="button"
                          onPress={() =>
                            setCollapsedStatuses((prev) => {
                              const next = new Set(prev);
                              if (next.has(status)) next.delete(status);
                              else next.add(status);
                              return next;
                            })
                          }
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            paddingHorizontal: 12,
                            paddingVertical: 9,
                            backgroundColor: theme.colors.surface2,
                          }}
                        >
                          <View
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <StatusIcon
                              status={status}
                              theme={theme}
                              size={14}
                            />
                            <Text
                              style={{
                                color: theme.colors.foreground,
                                fontSize: 13,
                                fontWeight: "700",
                              }}
                            >
                              {STATUS_LABELS[status]}
                            </Text>
                            <Text
                              style={{
                                color: theme.colors.foregroundMuted,
                                fontSize: 12,
                              }}
                            >
                              {groupTasks.length}
                            </Text>
                          </View>
                          <Pressable
                            accessibilityRole="button"
                            onPress={() => {
                              setNewTaskDefaultStatus(status);
                              setNewTaskOpen(true);
                            }}
                            style={{
                              paddingHorizontal: 7,
                              paddingVertical: 3,
                              borderRadius: 6,
                              backgroundColor: theme.colors.surface1,
                            }}
                          >
                            <Text
                              style={{
                                color: theme.colors.foreground,
                                fontSize: 11,
                              }}
                            >
                              + Add
                            </Text>
                          </Pressable>
                        </Pressable>

                        {!collapsed ? (
                          <View>
                            {groupTasks.length === 0 ? (
                              <Text
                                style={{
                                  padding: 12,
                                  color: theme.colors.foregroundMuted,
                                  fontSize: 12,
                                }}
                              >
                                No tasks in {STATUS_LABELS[status]}.
                              </Text>
                            ) : (
                              groupTasks.map((task) => {
                                const selected = selectedTaskKey === task.key;
                                const taskLabels = task.labelIds
                                  .map((id) => labelById.get(id))
                                  .filter((l): l is Label => Boolean(l));
                                return (
                                  <Pressable
                                    key={task.id}
                                    accessibilityRole="button"
                                    onPress={() =>
                                      setSelectedTaskKey(task.key)
                                    }
                                    style={{
                                      flexDirection: "row",
                                      alignItems: "center",
                                      gap: 10,
                                      paddingHorizontal: 12,
                                      paddingVertical: 10,
                                      borderTopWidth: 1,
                                      borderTopColor: theme.colors.border,
                                      backgroundColor: selected
                                        ? theme.colors.surface2
                                        : theme.colors.surface0,
                                    }}
                                  >
                                    <PriorityIcon
                                      priority={task.priority}
                                      theme={theme}
                                      size={13}
                                    />
                                    <Text
                                      style={{
                                        color: theme.colors.foregroundMuted,
                                        fontSize: 12,
                                        fontWeight: "700",
                                        width: 72,
                                      }}
                                    >
                                      {task.key}
                                    </Text>
                                    <Text
                                      numberOfLines={1}
                                      style={{
                                        color: theme.colors.foreground,
                                        fontSize: 13,
                                        fontWeight: "600",
                                        flex: 1,
                                      }}
                                    >
                                      {task.title}
                                    </Text>
                                    <View
                                      style={{
                                        flexDirection: "row",
                                        alignItems: "center",
                                        gap: 6,
                                      }}
                                    >
                                      {taskLabels.slice(0, 2).map((l) => (
                                        <LabelPill
                                          key={l.id}
                                          name={l.name}
                                          color={l.color}
                                          theme={theme}
                                        />
                                      ))}
                                      {task.dueDate ? (
                                        <Text
                                          style={{
                                            color:
                                              theme.colors.foregroundMuted,
                                            fontSize: 11,
                                          }}
                                        >
                                          {task.dueDate}
                                        </Text>
                                      ) : null}
                                    </View>
                                  </Pressable>
                                );
                              })
                            )}
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </ScrollView>
              )}
            </View>

            {/* Right Split Task Detail Pane (Wide Desktop) */}
            {!compact && selectedTaskKey ? (
              <View
                style={{
                  width: 420,
                  borderLeftWidth: 1,
                  borderLeftColor: theme.colors.border,
                  backgroundColor: theme.colors.surface0,
                }}
              >
                <TaskDetailView
                  taskKey={selectedTaskKey}
                  theme={theme}
                  compact={false}
                  onSelectTaskKey={setSelectedTaskKey}
                  onClose={() => setSelectedTaskKey(null)}
                  onOpenManagePresets={() => {
                    setManageTab("presets");
                    setManageOpen(true);
                  }}
                  openAgent={openAgent}
                  openWorkspace={openWorkspace}
                />
              </View>
            ) : null}
          </View>
        )}
      </View>

      <NewTaskModal
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        defaultProjectId={selectedProjectId ?? projects[0]?.id ?? null}
        defaultStatus={newTaskDefaultStatus}
        theme={theme}
        onCreated={(taskKey) => setSelectedTaskKey(taskKey)}
      />

      <ManageModal
        open={manageOpen}
        onOpenChange={setManageOpen}
        initialTab={manageTab}
        theme={theme}
      />
    </View>
  );
}

export function TasksScreen({
  theme,
  layout,
  params,
  navigation,
}: PluginScreenProps) {
  return (
    <TasksBoardAndListShell
      theme={theme}
      compact={layout.compact}
      initialTaskKey={params.taskKey ?? null}
      initialProjectId={params.projectId ?? null}
      openAgent={navigation?.openAgent}
      openWorkspace={navigation?.openWorkspace}
    />
  );
}

export function TasksWorkspacePanel({
  theme,
  layout,
  workspaceId,
  navigation,
}: PluginWorkspacePanelProps) {
  const ws = useWorkspace(workspaceId, (w) => ({
    projectId: w.projectId,
  }));

  return (
    <TasksBoardAndListShell
      theme={theme}
      compact={layout.compact}
      linkedPaseoProjectId={ws?.projectId ?? null}
      openAgent={navigation?.openAgent}
      openWorkspace={navigation?.openWorkspace}
    />
  );
}

export function TaskAgentPanel({
  theme,
  layout,
  workspaceId,
  agentId,
  navigation,
}: PluginAgentPanelProps) {
  const getAgentTasks = useRpc(getAgentTasksRpc);
  const ws = useWorkspace(workspaceId, (w) => ({
    projectId: w.projectId,
  }));
  const agent = useAgent(agentId, (a) => ({
    id: a.id,
    title: a.title,
    labels: a.labels,
  }));

  const agentTasksQuery = useQuery({
    queryKey: ["tasks", "agentTasks", agentId],
    queryFn: () => getAgentTasks({ agentId }),
    refetchInterval: 3000,
  });

  const labelTaskKey = agent?.labels?.taskKey ?? null;
  const attachedTasks = agentTasksQuery.data?.tasks ?? [];
  const defaultTaskKey = labelTaskKey ?? attachedTasks[0]?.key ?? null;

  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(
    defaultTaskKey,
  );

  useEffect(() => {
    if (!selectedTaskKey && defaultTaskKey) {
      setSelectedTaskKey(defaultTaskKey);
    }
  }, [defaultTaskKey, selectedTaskKey]);

  if (selectedTaskKey) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        {attachedTasks.length > 1 ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              padding: 10,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            {attachedTasks.map((t) => (
              <Pressable
                key={t.id}
                accessibilityRole="button"
                onPress={() => setSelectedTaskKey(t.key)}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor:
                    selectedTaskKey === t.key
                      ? theme.colors.accent
                      : theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color:
                      selectedTaskKey === t.key
                        ? theme.colors.accentForeground
                        : theme.colors.foreground,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  {t.key}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <TaskDetailView
          taskKey={selectedTaskKey}
          theme={theme}
          compact={layout.compact}
          onSelectTaskKey={setSelectedTaskKey}
          onClose={() => setSelectedTaskKey(null)}
          openAgent={navigation?.openAgent}
          openWorkspace={navigation?.openWorkspace}
        />
      </View>
    );
  }

  return (
    <TasksBoardAndListShell
      theme={theme}
      compact={layout.compact}
      linkedPaseoProjectId={ws?.projectId ?? null}
      openAgent={navigation?.openAgent}
      openWorkspace={navigation?.openWorkspace}
    />
  );
}

export function TasksSidebarItem({
  theme,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const sidebarOpenTaskCount = useRpc(sidebarOpenTaskCountRpc);
  const countQuery = useQuery({
    queryKey: ["tasks", "openCount"],
    queryFn: () => sidebarOpenTaskCount({}),
    refetchInterval: 5000,
  });

  const openCount = countQuery.data?.openTaskCount ?? 0;

  return (
    <SidebarRow
      icon="ListTodo"
      label="Tasks"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
      trailing={
        openCount > 0 ? (
          <View
            style={{
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 999,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              {openCount}
            </Text>
          </View>
        ) : undefined
      }
    />
  );
}
