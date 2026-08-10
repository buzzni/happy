import * as React from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AutomationApiError, type AutomationPayload, type AutomationSchedule } from '@slopus/happy-wire';
import { useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Text } from '@/components/StyledText';
import { Modal } from '@/modal';
import {
    createServerAutomationRepositoryForCredentials,
    type AutomationProject,
    type ServerAutomationItem,
} from '@/sync/serverAutomations';
import { subscribeAutomationUpdates } from '@/sync/automationUpdates';
import {
    automationDraftFor,
    automationPayloadFromDraft,
    type AutomationDraft,
} from '@/sync/automationDraft';
import { t } from '@/text';

const AUTOMATION_AGENTS: Array<{ value: AutomationPayload['agent']; label: string }> = [
    { value: null, label: 'Default' },
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini' },
    { value: 'openclaw', label: 'OpenClaw' },
    { value: 'opencode', label: 'OpenCode' },
];

function scheduleLabel(schedule: AutomationSchedule): string {
    return schedule.kind === 'interval'
        ? `Every ${schedule.minutes} minutes`
        : `Daily at ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
}

function runLabel(item: ServerAutomationItem): string {
    if (item.runs.length === 0) return 'No runs yet';
    return item.runs.slice(0, 5).map((run) => {
        const result = (run.outcome ?? run.status).toLowerCase().replaceAll('_', ' ');
        const session = run.sessionId ? ` · session ${run.sessionId}` : '';
        return `${new Date(run.completedAt ?? run.claimedAt).toLocaleString()} · ${result}${session}`;
    }).join('\n');
}

function errorMessage(error: unknown): string {
    if (error instanceof AutomationApiError && error.status === 409) return 'This automation changed elsewhere. The latest version was reloaded.';
    if (error instanceof AutomationApiError && error.status === 404) return 'Server-backed automations are not enabled for this account.';
    return error instanceof Error ? error.message : String(error);
}

export function AutomationsSettingsView() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const repository = React.useMemo(
        () => auth.credentials ? createServerAutomationRepositoryForCredentials(auth.credentials) : null,
        [auth.credentials],
    );
    const [projects, setProjects] = React.useState<AutomationProject[]>([]);
    const [itemsByProject, setItemsByProject] = React.useState<Record<string, ServerAutomationItem[]>>({});
    const [errorsByProject, setErrorsByProject] = React.useState<Record<string, string | null>>({});
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [busyProjectId, setBusyProjectId] = React.useState<string | null>(null);
    const [draft, setDraft] = React.useState<AutomationDraft | null>(null);
    const [draftError, setDraftError] = React.useState<string | null>(null);

    const reloadProject = React.useCallback(async (projectId: string) => {
        if (!repository) return;
        try {
            const items = await repository.listProject(projectId);
            setItemsByProject((current) => ({ ...current, [projectId]: items }));
            setErrorsByProject((current) => ({ ...current, [projectId]: null }));
        } catch (error) {
            setErrorsByProject((current) => ({ ...current, [projectId]: errorMessage(error) }));
            throw error;
        }
    }, [repository]);

    const loadAll = React.useCallback(async () => {
        if (!repository) return;
        setLoading(true);
        try {
            const nextProjects = await repository.listProjects();
            setProjects(nextProjects);
            setLoadError(null);
            await Promise.allSettled(nextProjects.map((project) => reloadProject(project.id)));
        } catch (error) {
            setLoadError(errorMessage(error));
        } finally {
            setLoading(false);
        }
    }, [reloadProject, repository]);

    React.useEffect(() => { void loadAll(); }, [loadAll]);
    React.useEffect(() => subscribeAutomationUpdates((update) => {
        if (update.projectId) void reloadProject(update.projectId).catch(() => undefined);
        else for (const project of projects) void reloadProject(project.id).catch(() => undefined);
    }), [projects, reloadProject]);

    const mutate = React.useCallback(async (
        projectId: string,
        operation: () => Promise<void>,
    ) => {
        setBusyProjectId(projectId);
        try {
            await operation();
            setErrorsByProject((current) => ({ ...current, [projectId]: null }));
        } catch (error) {
            if (error instanceof AutomationApiError && error.status === 409) {
                await reloadProject(projectId).catch(() => undefined);
            }
            setErrorsByProject((current) => ({ ...current, [projectId]: errorMessage(error) }));
            throw error;
        } finally {
            setBusyProjectId(null);
        }
    }, [reloadProject]);

    const saveDraft = React.useCallback(async () => {
        if (!draft || !repository) return;
        try {
            const payload = automationPayloadFromDraft(draft);
            await mutate(draft.projectId, async () => {
                const saved = draft.item
                    ? await repository.update(draft.item, payload)
                    : await repository.create(draft.projectId, payload);
                setItemsByProject((current) => ({
                    ...current,
                    [draft.projectId]: [
                        ...(current[draft.projectId] ?? []).filter((item) => item.row.id !== saved.row.id),
                        saved,
                    ],
                }));
                setDraft(null);
                setDraftError(null);
            });
        } catch (error) {
            if (error instanceof AutomationApiError && error.status === 409) setDraft(null);
            setDraftError(errorMessage(error));
        }
    }, [draft, mutate, repository]);

    if (!repository) return <ItemList><Item title="Sign in to manage automations." showChevron={false} /></ItemList>;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup footer={loadError ?? 'Automations are encrypted end to end. Server failures never create a local mutation queue.'}>
                <Item
                    title="Scheduled Automations"
                    subtitle="Shared with Desktop through Happy Server"
                    icon={<Ionicons name="time-outline" size={29} color="#5856D6" />}
                    onPress={() => { void loadAll(); }}
                    loading={loading}
                    showChevron={false}
                />
            </ItemGroup>

            {projects.map((project) => {
                const items = itemsByProject[project.id] ?? [];
                const editable = project.membership !== 'viewer';
                return (
                    <ItemGroup
                        key={project.id}
                        title={project.name}
                        footer={errorsByProject[project.id] ?? (editable ? 'Changes run after the target daemon syncs.' : 'Viewer access is read-only.')}
                    >
                        {items.map((item) => (
                            <Item
                                key={item.row.id}
                                title={item.payload.name}
                                subtitle={`${scheduleLabel(item.payload.schedule)} · ${item.row.paused ? 'Paused' : item.row.appliedRevision >= item.row.revision ? 'Synced' : 'Pending daemon sync'}\n${runLabel(item)}`}
                                subtitleLines={8}
                                onPress={editable ? () => { setDraft(automationDraftFor(project, item)); setDraftError(null); } : undefined}
                                rightElement={editable ? (
                                    <View style={{ flexDirection: 'row', gap: 8 }}>
                                        <Pressable
                                            accessibilityLabel={item.row.paused ? 'Resume automation' : 'Pause automation'}
                                            disabled={busyProjectId === project.id}
                                            onPress={() => { void mutate(project.id, async () => {
                                                const saved = await repository.setPaused(item, !item.row.paused);
                                                setItemsByProject((current) => ({
                                                    ...current,
                                                    [project.id]: (current[project.id] ?? []).map((candidate) => candidate.row.id === saved.row.id ? saved : candidate),
                                                }));
                                            }).catch(() => undefined); }}
                                        >
                                            <Ionicons name={item.row.paused ? 'play-outline' : 'pause-outline'} size={22} color={theme.colors.textLink} />
                                        </Pressable>
                                        <Pressable
                                            accessibilityLabel="Delete automation"
                                            disabled={busyProjectId === project.id}
                                            onPress={() => { void (async () => {
                                                const confirmed = await Modal.confirm('Delete automation?', item.payload.name, {
                                                    cancelText: t('common.cancel'), confirmText: t('common.delete'), destructive: true,
                                                });
                                                if (!confirmed) return;
                                                await mutate(project.id, async () => {
                                                    await repository.remove(item);
                                                    setItemsByProject((current) => ({
                                                        ...current,
                                                        [project.id]: (current[project.id] ?? []).filter((candidate) => candidate.row.id !== item.row.id),
                                                    }));
                                                });
                                            })().catch(() => undefined); }}
                                        >
                                            <Ionicons name="trash-outline" size={22} color={theme.colors.textDestructive} />
                                        </Pressable>
                                    </View>
                                ) : undefined}
                            />
                        ))}
                        {items.length === 0 && !errorsByProject[project.id] ? <Item title="No automations" showChevron={false} /> : null}
                        {editable ? (
                            <Item
                                title="Add automation"
                                icon={<Ionicons name="add-circle-outline" size={29} color="#34C759" />}
                                onPress={() => { setDraft(automationDraftFor(project, null)); setDraftError(null); }}
                                disabled={busyProjectId === project.id}
                            />
                        ) : null}
                    </ItemGroup>
                );
            })}

            {draft ? (
                <ItemGroup title={draft.item ? 'Edit automation' : 'New automation'} footer={draftError ?? 'Intervals must be at least 15 minutes.'}>
                    <AutomationInput label="Name" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} />
                    <AutomationInput label="Prompt" value={draft.prompt} multiline onChangeText={(prompt) => setDraft({ ...draft, prompt })} />
                    <AutomationInput label="Workspace directory" value={draft.directory} onChangeText={(directory) => setDraft({ ...draft, directory })} />
                    <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12 }}>
                        {(['interval', 'daily'] as const).map((kind) => (
                            <Pressable key={kind} onPress={() => setDraft({ ...draft, scheduleKind: kind })}>
                                <Text style={{ color: draft.scheduleKind === kind ? theme.colors.textLink : theme.colors.textSecondary }}>
                                    {kind === 'interval' ? 'Interval' : 'Daily'}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                    <AutomationInput
                        label={draft.scheduleKind === 'interval' ? 'Minutes' : 'Time (HH:MM)'}
                        value={draft.scheduleKind === 'interval' ? draft.intervalMinutes : draft.dailyTime}
                        onChangeText={(value) => setDraft(draft.scheduleKind === 'interval'
                            ? { ...draft, intervalMinutes: value }
                            : { ...draft, dailyTime: value })}
                    />
                    <AutomationInput label="Gate script (optional)" value={draft.scriptCommand} onChangeText={(scriptCommand) => setDraft({ ...draft, scriptCommand })} />
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, paddingTop: 12 }}>
                        {AUTOMATION_AGENTS.map((agent) => (
                            <Pressable key={agent.value ?? 'default'} onPress={() => setDraft({ ...draft, agent: agent.value })}>
                                <Text style={{ color: draft.agent === agent.value ? theme.colors.textLink : theme.colors.textSecondary }}>
                                    {agent.label}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                    <Item
                        title="Suppress silent results"
                        detail={draft.suppressSilent ? 'On' : 'Off'}
                        showChevron={false}
                        onPress={() => setDraft({ ...draft, suppressSilent: !draft.suppressSilent })}
                    />
                    <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end', padding: 16 }}>
                        <Pressable onPress={() => { setDraft(null); setDraftError(null); }}><Text style={{ color: theme.colors.textSecondary }}>{t('common.cancel')}</Text></Pressable>
                        <Pressable onPress={() => { void saveDraft(); }} disabled={busyProjectId === draft.projectId}>
                            {busyProjectId === draft.projectId ? <ActivityIndicator /> : <Text style={{ color: theme.colors.textLink }}>{t('common.save')}</Text>}
                        </Pressable>
                    </View>
                </ItemGroup>
            ) : null}
        </ItemList>
    );
}

function AutomationInput(props: {
    label: string;
    value: string;
    multiline?: boolean;
    onChangeText: (value: string) => void;
}) {
    const { theme } = useUnistyles();
    return (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{props.label}</Text>
            <TextInput
                accessibilityLabel={props.label}
                value={props.value}
                multiline={props.multiline}
                onChangeText={props.onChangeText}
                placeholderTextColor={theme.colors.input.placeholder}
                style={{
                    minHeight: props.multiline ? 88 : 42,
                    color: theme.colors.input.text,
                    backgroundColor: theme.colors.input.background,
                    borderColor: theme.colors.divider,
                    borderWidth: 1,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    textAlignVertical: props.multiline ? 'top' : 'center',
                }}
            />
        </View>
    );
}
