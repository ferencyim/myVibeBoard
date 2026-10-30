import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { statusRpc, type Changes, type Status } from "../shared/rpc";

const labels: Record<string, string> = {
  ok: "正常",
  success: "成功",
  succeeded: "成功",
  passed: "通过",
  completed: "已完成",
  published: "已发布",
  failed: "失败",
  failure: "失败",
  error: "错误",
  no_token: "缺少令牌",
  unreachable: "无法连接",
  running: "进行中",
  pending: "等待中",
  queued: "排队中",
  uploading: "上传中",
  idle: "空闲",
  skipped: "已跳过",
  cancelled: "已取消",
  unknown: "未知",
  unchanged: "无变化",
  not_applicable: "不适用",
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 12, paddingBottom: 32, gap: 10 },
  toolbar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  refresh: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  section: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 7, minWidth: 0 },
  title: { fontWeight: "600", fontSize: 15 },
  heading: { fontWeight: "600", flexShrink: 1 },
  subheading: { fontSize: 13, flexShrink: 1 },
  line: { fontSize: 12, lineHeight: 18, flexShrink: 1 },
  worktree: { borderWidth: 1, borderRadius: 8, padding: 8, gap: 3, minWidth: 0 },
  group: { gap: 3, minWidth: 0 },
  product: { gap: 5, minWidth: 0 },
  item: { gap: 2, minWidth: 0 },
});

function label(value: string | null | undefined) {
  return value ? (labels[value.toLowerCase()] ?? value) : "未知";
}

function statusColor(theme: PluginTheme, value: string | null | undefined) {
  const status = value?.toLowerCase() ?? "";
  if (["ok", "success", "succeeded", "passed", "completed", "published"].includes(status)) {
    return theme.colors.statusSuccess;
  }
  if (["failed", "failure", "error", "no_token", "unreachable"].includes(status)) {
    return theme.colors.statusDanger;
  }
  if (["running", "pending", "queued", "uploading", "in_progress", "waiting"].includes(status)) {
    return theme.colors.statusWarning;
  }
  return theme.colors.foregroundMuted;
}

function date(value: string | number | null | undefined) {
  if (!value) return "未知";
  const d = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(d.getTime()) ? "未知" : d.toLocaleString("zh-CN");
}

function relative(value: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - (value < 1e12 ? value * 1000 : value)) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function counts(value: { ahead: number; behind: number } | null) {
  return value ? `领先 ${value.ahead} / 落后 ${value.behind}` : "未知";
}

function changes(value: Changes | null) {
  return value
    ? `${value.total} 个文件（已暂存 ${value.staged}，未暂存 ${value.unstaged}，未跟踪 ${value.untracked}）`
    : "未知";
}

function tail(path: string) {
  return path.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || path;
}

function Section({ theme, title, children }: { theme: PluginTheme; title: string; children: ReactNode }) {
  return (
    <View style={[
      styles.section,
      { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
    ]}>
      <Text style={[styles.title, { color: theme.colors.foreground }]}>{title}</Text>
      {children}
    </View>
  );
}

function Line({ theme, children, warning = false, danger = false }: {
  theme: PluginTheme;
  children: ReactNode;
  warning?: boolean;
  danger?: boolean;
}) {
  const color = danger ? theme.colors.statusDanger :
    warning ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return (
    <Text selectable style={[styles.line, { color }]}>
      {children}
    </Text>
  );
}

function StatusText({ theme, value }: { theme: PluginTheme; value: string | null | undefined }) {
  return <Text style={{ color: statusColor(theme, value) }}>{label(value)}</Text>;
}

function SectionMessage({ theme, status }: { theme: PluginTheme; status: string }) {
  const message = status === "dashboard_down"
    ? "CI 面板未运行（127.0.0.1:43173）"
    : status === "not_configured"
      ? "此项目未接入 CI"
      : status === "error" ? "读取失败" : "加载中…";
  return <Line theme={theme} danger={status === "error" || status === "dashboard_down"}>{message}</Line>;
}

function Version({ value }: {
  value: { displayVersion: string | null; build: string | null; stateChangedAt: string | null };
}) {
  return <>{`${value.displayVersion ?? "未知版本"}${value.build ? `（${value.build}）` : ""}${
    value.stateChangedAt ? ` · ${date(value.stateChangedAt)}` : ""
  }`}</>;
}

function GitSections({ theme, git }: { theme: PluginTheme; git?: Status["git"] }) {
  return (
    <>
      <Section theme={theme} title="当前位置">
        {!git ? <Line theme={theme}>加载中…</Line> : git.status === "not_git" ? (
          <Line theme={theme}>不是 Git 仓库</Line>
        ) : git.status === "error" ? (
          <Line theme={theme} danger>Git 状态读取失败</Line>
        ) : (
          <>
            <Text style={[styles.heading, { color: theme.colors.foreground }]}>
              {git.branch ?? `游离 HEAD ${git.headSha ?? ""}`} · {git.isMain ? "主检出" : "附加 worktree"}
            </Text>
            <Line theme={theme}>{git.workspacePath}</Line>
            <Line theme={theme}>{`HEAD ${git.headSha ?? "未知"} ${git.headSubject ?? ""}`}</Line>
            <Line theme={theme}>{`基线 ${git.base ?? "未知"}：${counts(git.baseCounts)}`}</Line>
            <Line theme={theme}>{`上游 ${git.upstream ?? "未设置"}：${counts(git.upstreamCounts)}`}</Line>
            <Line theme={theme}>{`未提交：${changes(git.changes)}`}</Line>
            {git.operation ? <Line theme={theme} warning>{`进行中的操作：${git.operation}`}</Line> : null}
            <Line theme={theme}>最近提交</Line>
            {git.commits.length ? git.commits.map((commit) => (
              <Line key={commit.sha} theme={theme}>
                {`${commit.sha} ${commit.subject} · ${relative(commit.timestamp)}`}
              </Line>
            )) : <Line theme={theme}>暂无提交</Line>}
          </>
        )}
      </Section>
      <Section theme={theme} title="同仓库 worktree">
        {!git ? <Line theme={theme}>加载中…</Line> : git.status !== "ok" ? (
          <Line theme={theme}>暂无 worktree 信息</Line>
        ) : git.worktrees.map((worktree) => (
          <View key={worktree.path} style={[
            styles.worktree,
            { borderColor: worktree.current ? theme.colors.accent : theme.colors.border },
          ]}>
            <Text style={[styles.heading, styles.subheading, { color: theme.colors.foreground }]}>
              {`${worktree.branch ?? "游离 HEAD"} · ${tail(worktree.path)}${worktree.current ? " · 当前" : ""}`}
            </Text>
            <Line theme={theme}>
              {worktree.counts ? `+${worktree.counts.ahead} / -${worktree.counts.behind}` : "领先/落后未知"}
              {worktree.merged ? <Text style={{ color: theme.colors.statusSuccess }}> · 已合并</Text> : null}
              {worktree.changes?.total ? (
                <Text style={{ color: theme.colors.statusWarning }}>
                  {` · 有改动 ${worktree.changes.total}`}
                </Text>
              ) : worktree.changes ? null : " · 改动未知"}
              {worktree.prunable || worktree.missing ? (
                <Text style={{ color: theme.colors.statusDanger }}> · 失效</Text>
              ) : null}
            </Line>
          </View>
        ))}
      </Section>
    </>
  );
}

function BuildSection({ theme, build }: { theme: PluginTheme; build?: Status["build"] }) {
  return (
    <Section theme={theme} title="构建">
      {!build || build.status !== "ok" ? (
        <SectionMessage theme={theme} status={build?.status ?? "loading"} />
      ) : (
        build.pipelines.map((pipeline, i) => (
          <View key={`${pipeline.repo}-${pipeline.project}-${i}`} style={styles.group}>
            <Text style={[styles.heading, { color: theme.colors.foreground }]}>
              {pipeline.project ?? "流水线"} · <StatusText theme={theme} value={pipeline.status} />
              {"（构建 "}<StatusText theme={theme} value={pipeline.buildStatus} />{"）"}
            </Text>
            {pipeline.failureReason ? (
              <Line theme={theme} danger>{`失败原因：${pipeline.failureReason}`}</Line>
            ) : null}
            {pipeline.clientStatuses.map((client, n) => (
              <Line key={`${client.client}-${n}`} theme={theme}>
                {client.client}：构建 <StatusText theme={theme} value={client.buildStatus} />
                {" / 上传 "}<StatusText theme={theme} value={client.uploadStatus} />
                {" / 发布 "}<StatusText theme={theme} value={client.publishStatus} />
              </Line>
            ))}
            <Line theme={theme}>
              上传 <StatusText theme={theme} value={pipeline.upload} />
              {" / 发布 "}<StatusText theme={theme} value={pipeline.publish} />
            </Line>
            <Line theme={theme}>{`开始 ${date(pipeline.startedAt)} · 结束 ${date(pipeline.finishedAt)}`}</Line>
            <Line theme={theme}>
              {`构建提交 ${pipeline.sourceSha ?? "未知"} · ${pipeline.shaRelation.status === "same"
                ? "与 origin/main 相同"
                : pipeline.shaRelation.status === "behind"
                  ? `落后 origin/main ${pipeline.shaRelation.count} 个提交`
                  : "与 origin/main 关系未知"}`}
            </Line>
          </View>
        ))
      )}
    </Section>
  );
}

function ReleaseSection({ theme, release }: { theme: PluginTheme; release?: Status["release"] }) {
  return (
    <Section theme={theme} title="发布">
      {!release || release.status !== "ok" ? (
        <SectionMessage theme={theme} status={release?.status ?? "loading"} />
      ) : (
        release.products.map((product) => (
          <View key={product.id} style={styles.product}>
            <Text style={[styles.heading, { color: theme.colors.foreground }]}>
              {product.name} · <StatusText theme={theme} value={product.status} />
              {product.stale ? <Text style={{ color: theme.colors.statusWarning }}> · 旧数据</Text> : null}
            </Text>
            {product.fetchedAt ? <Line theme={theme}>{`更新于 ${date(product.fetchedAt)}`}</Line> : null}
            {product.items.map((item, i) => {
              const empty = !item.released && !item.testing && !item.rollingOut &&
                item.unreleasedCommitCount == null && !item.lastGateFailure && !item.storeSubmission;
              return (
                <View key={`${item.targetKey}-${i}`} style={styles.item}>
                  <Text style={[styles.subheading, { color: theme.colors.foreground }]}>
                    {`${item.platform} · ${item.channel}${empty ? "：暂无版本" : ""}`}
                  </Text>
                  {item.released ? (
                    <Line theme={theme}>
                      正式版：
                      <Text style={{ color: theme.colors.statusSuccess }}>
                        <Version value={item.released} />
                      </Text>
                    </Line>
                  ) : null}
                  {item.testing ? <Line theme={theme}>内测：<Version value={item.testing} /></Line> : null}
                  {item.rollingOut ? (
                    <Line theme={theme}>放量：<Version value={item.rollingOut} /></Line>
                  ) : null}
                  {item.unreleasedCommitCount != null ? (
                    <Line theme={theme}>{`未发布提交：${item.unreleasedCommitCount}`}</Line>
                  ) : null}
                  {item.storeSubmission ? (
                    <Line theme={theme}>商店状态：<StatusText theme={theme} value={item.storeSubmission} /></Line>
                  ) : null}
                  {item.lastGateFailure ? (
                    <Line theme={theme} danger>{`最近门禁失败：${item.lastGateFailure}`}</Line>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))
      )}
    </Section>
  );
}

export function GitPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const call = useRpc(statusRpc);
  const query = useQuery({
    queryKey: ["vibe-git", "status", workspaceId],
    queryFn: () => call({ workspaceId }),
    refetchInterval: 30_000,
    retry: false,
  });
  const updatedAt = query.dataUpdatedAt
    ? new Date(query.dataUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : null;

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.surface0 }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="刷新 Git 和构建状态"
            onPress={() => void query.refetch()}
            style={[styles.refresh, { backgroundColor: theme.colors.surface2 }]}
          >
            <Text style={{ color: theme.colors.foreground }}>刷新</Text>
          </Pressable>
          {updatedAt ? <Line theme={theme}>{`更新于 ${updatedAt}`}</Line> : null}
          {query.isFetching ? <Line theme={theme} warning>刷新中…</Line> : null}
        </View>
        {query.error ? <Line theme={theme} danger>状态读取失败，请刷新重试。</Line> : null}
        <GitSections theme={theme} git={query.data?.git} />
        <BuildSection theme={theme} build={query.data?.build} />
        <ReleaseSection theme={theme} release={query.data?.release} />
      </ScrollView>
    </View>
  );
}

