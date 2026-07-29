import { application } from '@application'
import type { StudioDraftSnapshot } from '@chemsmart/studio-protocol'
import { chemsmartStudioErrorCodes } from '@shared/ipc/errors/chemsmartStudio'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type { chemsmartStudioRequestSchemas } from '@shared/ipc/schemas/chemsmartStudio'
import type { IpcHandlersFor } from '@shared/ipc/types'

const studioErrorCodeSet = new Set<string>(Object.values(chemsmartStudioErrorCodes))

async function workspaceOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof IpcError) throw error
    const candidate = error as { message?: unknown; data?: { studioCode?: unknown } }
    const code = candidate.data?.studioCode
    if (typeof code === 'string' && studioErrorCodeSet.has(code)) {
      throw new IpcError(code, typeof candidate.message === 'string' ? candidate.message : code)
    }
    if ((error as { code?: unknown }).code === -32002) {
      throw new IpcError(chemsmartStudioErrorCodes.RPC_TIMEOUT, 'Molecule workspace request timed out')
    }
    throw new IpcError(
      chemsmartStudioErrorCodes.EDITOR_UNAVAILABLE,
      typeof candidate.message === 'string' ? candidate.message : 'Molecule workspace is unavailable'
    )
  }
}

async function agentRequest<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof IpcError) throw error
    const message = error instanceof Error ? error.message : 'ChemSmart agent is unavailable'
    if ((error as { code?: unknown }).code === -32002) {
      throw new IpcError(chemsmartStudioErrorCodes.RPC_TIMEOUT, message)
    }
    throw new IpcError(chemsmartStudioErrorCodes.AGENT_UNAVAILABLE, message)
  }
}

function publishDraftChanged(sessionId: string, snapshot: StudioDraftSnapshot | null): void {
  application.get('IpcApiService').broadcast('chemsmart_studio.molecule.draft_changed', { sessionId, snapshot })
}

export const chemsmartStudioHandlers: IpcHandlersFor<typeof chemsmartStudioRequestSchemas> = {
  'chemsmart_studio.status': async () => ({
    agent: application.get('ChemSmartAgentService').getStatus()
  }),
  'chemsmart_studio.editor.open_project': () =>
    workspaceOperation(() => application.get('MoleculeWorkspaceService').openProject()),
  'chemsmart_studio.editor.import_molecule': () =>
    workspaceOperation(() => application.get('MoleculeWorkspaceService').importMolecule()),
  'chemsmart_studio.editor.save_as': () =>
    workspaceOperation(() => application.get('MoleculeWorkspaceService').saveProjectAs()),
  'chemsmart_studio.editor.open_documents': async (_input, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('MoleculeWorkspaceService').listOpenDocuments()
  },
  'chemsmart_studio.editor.activate_document': async ({ projectId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() => application.get('MoleculeWorkspaceService').activateDocument(projectId))
  },
  'chemsmart_studio.molecule.summary': async () => {
    const summary = application.get('MoleculeWorkspaceService').getCachedMoleculeSummary()
    if (!summary) throw new IpcError(chemsmartStudioErrorCodes.EDITOR_UNAVAILABLE, 'No validated molecule is available')
    return summary
  },
  'chemsmart_studio.molecule.document': async (_input, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() => application.get('MoleculeWorkspaceService').getMoleculeDocument())
  },
  'chemsmart_studio.molecule.set_selection': async (
    { sessionId, documentId, expectedRevision, atomIds },
    { senderId }
  ) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() =>
      application
        .get('StudioControlService')
        .setHumanSelection(sessionId, senderId, { documentId, expectedRevision, atomIds })
    )
  },
  'chemsmart_studio.molecule.propose_patch': async (
    { sessionId, expectedRevision, mode, operations },
    { senderId }
  ) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() =>
      application
        .get('StudioControlService')
        .proposeHumanPatch(sessionId, senderId, { expectedRevision, mode, operations })
    )
  },
  'chemsmart_studio.molecule.draft_snapshot': async ({ sessionId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('StudioControlService').getHumanDraft(sessionId, senderId)
  },
  'chemsmart_studio.molecule.draft_apply': async (
    { sessionId, expectedRevision, mode, operations, gesture },
    { senderId }
  ) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    const snapshot = await workspaceOperation(() =>
      application
        .get('StudioControlService')
        .applyHumanDraft(sessionId, senderId, { expectedRevision, mode, operations, ...(gesture ? { gesture } : {}) })
    )
    publishDraftChanged(sessionId, snapshot)
    return snapshot
  },
  'chemsmart_studio.molecule.draft_undo': async ({ sessionId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    const snapshot = await workspaceOperation(() =>
      application.get('StudioControlService').undoHumanDraft(sessionId, senderId)
    )
    publishDraftChanged(sessionId, snapshot)
    return snapshot
  },
  'chemsmart_studio.molecule.draft_redo': async ({ sessionId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    const snapshot = await workspaceOperation(() =>
      application.get('StudioControlService').redoHumanDraft(sessionId, senderId)
    )
    publishDraftChanged(sessionId, snapshot)
    return snapshot
  },
  'chemsmart_studio.molecule.draft_commit': async ({ sessionId, expectedRevision }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    const document = await workspaceOperation(() =>
      application.get('StudioControlService').commitHumanDraft(sessionId, senderId, expectedRevision)
    )
    publishDraftChanged(sessionId, null)
    return document
  },
  'chemsmart_studio.molecule.draft_discard': async ({ sessionId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    const document = await workspaceOperation(() =>
      application.get('StudioControlService').discardHumanDraft(sessionId, senderId)
    )
    publishDraftChanged(sessionId, null)
    return document
  },
  'chemsmart_studio.molecule.undo': async ({ sessionId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() => application.get('StudioControlService').undoHuman(sessionId, senderId))
  },
  'chemsmart_studio.molecule.redo': async ({ sessionId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() => application.get('StudioControlService').redoHuman(sessionId, senderId))
  },
  // Named research threads. The renderer never learns where the project lives: it receives an
  // opaque projectId, a display name, and thread identifiers main issued.
  'chemsmart_studio.research_session.context': async (_input, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('ResearchProjectSessionService').getContext()
  },
  'chemsmart_studio.research_session.create_thread': async ({ title }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('ResearchProjectSessionService').createThread(title)
  },
  'chemsmart_studio.research_session.rename_thread': async ({ threadId, title }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('ResearchProjectSessionService').renameThread(threadId, title)
  },
  'chemsmart_studio.research_session.select_thread': async ({ threadId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('ResearchProjectSessionService').selectThread(threadId)
  },
  // The researcher's own path into the harness: no model decides what these mean, and the agent service
  // validates each answer against a closed generated contract.
  'chemsmart_studio.project.list': async (input, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return agentRequest(() => application.get('ChemSmartAgentService').listProjects(input))
  },
  'chemsmart_studio.project.read': async (input, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return agentRequest(() => application.get('ChemSmartAgentService').readProject(input))
  },
  'chemsmart_studio.project.validate': async (input, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return agentRequest(() => application.get('ChemSmartAgentService').validateProject(input))
  },
  'chemsmart_studio.project.critic': async (input, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return agentRequest(() => application.get('ChemSmartAgentService').critiqueProject(input))
  },
  'chemsmart_studio.command.synthesize': async (input, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return agentRequest(() => application.get('ChemSmartAgentService').synthesizeCommand(input, senderId))
  },
  'chemsmart_studio.agent.runtime_context': async () => ({
    deterministicModelId: application.get('ChemSmartAgentService').getDeterministicModelId()
  }),
  'chemsmart_studio.agent.run_turn': async ({ sessionId, modelId, request }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    await agentRequest(() => application.get('ChemSmartAgentService').runTurn(sessionId, modelId, request, senderId))
    return { completed: true }
  },
  'chemsmart_studio.agent.turns': async ({ threadId, beforeSequence, limit }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('StudioAgentProjectionService').getPage(threadId, beforeSequence, limit)
  },
  'chemsmart_studio.agent.capabilities': async ({ sessionId, threadId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('StudioAgentProjectionService').getCapabilityManifest(threadId, sessionId)
  },
  'chemsmart_studio.agent.update_workspace_view': async ({ sessionId, view }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    application.get('StudioControlService').claimSessionControl(sessionId, senderId)
    application.get('CalculationRuntimeService').setWorkspaceViewState(sessionId, view)
    return { accepted: true }
  },
  'chemsmart_studio.agent.replay_studio_ui': async ({ sessionId, afterSequence }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return agentRequest(() =>
      application.get('ChemSmartAgentService').replayStudioUi(sessionId, afterSequence, senderId)
    )
  },
  'chemsmart_studio.command.inspect': async (request, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return agentRequest(() => application.get('ChemSmartAgentService').inspectCommand(request))
  },
  'chemsmart_studio.control.snapshot': async ({ sessionId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('StudioControlService').getSnapshot(sessionId, senderId)
  },
  'chemsmart_studio.control.perform_action': async ({ sessionId, actionId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('StudioControlService').performAction(sessionId, actionId, senderId)
  },
  'chemsmart_studio.optimization.replay_catalog': async ({ sessionId, afterRunId, limit }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() =>
      application.get('StudioControlService').getReplayCatalog(sessionId, senderId, afterRunId, limit)
    )
  },
  'chemsmart_studio.optimization.replay_timeline': async ({ sessionId, runId, offset, limit }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() =>
      application.get('StudioControlService').getReplayTimeline(sessionId, senderId, runId, offset, limit)
    )
  },
  'chemsmart_studio.optimization.replay_frame': async ({ sessionId, runId, stepIndex }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() =>
      application.get('StudioControlService').selectReplayFrame(sessionId, senderId, runId, stepIndex)
    )
  },
  'chemsmart_studio.optimization.stop_replay': async ({ sessionId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return workspaceOperation(() => application.get('StudioControlService').stopReplay(sessionId, senderId))
  },
  'chemsmart_studio.agent.set_mode': async ({ sessionId, mode }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return { mode: application.get('StudioControlService').setAgentMode(sessionId, mode, senderId) }
  },
  'chemsmart_studio.console.run': async ({ command }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('StudioConsoleService').run(command)
  },
  'chemsmart_studio.console.cancel': async ({ runId }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    await application.get('StudioConsoleService').cancel(runId)
    return { cancelled: true as const }
  },
  'chemsmart_studio.console.complete': async ({ line, cursor }, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('StudioConsoleService').complete(line, cursor)
  },
  'chemsmart_studio.workspace.roots': async (_input, { senderId }) => {
    if (!senderId) throw new IpcError('FORBIDDEN_SENDER', 'A managed Studio window is required')
    return application.get('MoleculeWorkspaceService').getWorkspaceRoots()
  }
}
