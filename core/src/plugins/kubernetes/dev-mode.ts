/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { hotReloadSyncSchema } from "../container/config"
import { dedent, gardenAnnotationKey } from "../../util/string"
import { set } from "lodash"
import { getResourceContainer, getResourcePodSpec } from "./util"
import { HotReloadableResource } from "./hot-reload/hot-reload"
import { LogEntry } from "../../logger/log-entry"
import { joinWithPosix } from "../../util/fs"
import chalk from "chalk"
import { PluginContext } from "../../plugin-context"
import { ConfigurationError } from "../../exceptions"
import {
  ensureMutagenSync,
  getKubectlExecDestination,
  mutagenAgentPath,
  mutagenConfigLock,
  SyncConfig,
} from "./mutagen"
import { joi, joiIdentifier } from "../../config/common"
import { KubernetesPluginContext, KubernetesProvider } from "./config"
import { isConfiguredForDevMode } from "./status/status"
import { k8sSyncUtilImageName } from "./constants"

export const builtInExcludes = ["/**/*.git", "**/*.garden"]

export const devModeGuideLink = "https://docs.garden.io/guides/code-synchronization-dev-mode"

interface ConfigureDevModeParams {
  target: HotReloadableResource
  spec: ContainerDevModeSpec
  containerName?: string
}

export interface ContainerDevModeSpec {
  args?: string[]
  command?: string[]
  sync: DevModeSyncSpec[]
}

export const devModeSyncSchema = () =>
  hotReloadSyncSchema().keys({
    exclude: syncExcludeSchema(),
    mode: joi
      .string()
      .allow(
        "one-way",
        "one-way-safe",
        "one-way-replica",
        "one-way-reverse",
        "one-way-replica-reverse",
        "two-way",
        "two-way-safe",
        "two-way-resolved"
      )
      .only()
      .default("one-way-safe")
      .description(
        "The sync mode to use for the given paths. See the [Dev Mode guide](https://docs.garden.io/guides/code-synchronization-dev-mode) for details."
      ),
    defaultFileMode: syncDefaultFileModeSchema(),
    defaultDirectoryMode: syncDefaultDirectoryModeSchema(),
    defaultOwner: syncDefaultOwnerSchema(),
    defaultGroup: syncDefaultGroupSchema(),
  })

const devModeDescription = (mentionServiceResource: boolean) => {
  const serviceResourceDescription = mentionServiceResource
    ? "Note that `serviceResource` must also be specified to enable dev mode.\n\n"
    : ""
  return dedent`
    Specifies which files or directories to sync to which paths inside the running containers of the service when it's in dev mode, and overrides for the container command and/or arguments.

    ${serviceResourceDescription}
    Dev mode is enabled when running the \`garden dev\` command, and by setting the \`--dev\` flag on the \`garden deploy\` command.

    See the [Code Synchronization guide](${devModeGuideLink}) for more information.
  `
}

export const containerDevModeSchema = () =>
  joi
    .object()
    .keys({
      args: joi
        .sparseArray()
        .items(joi.string())
        .description("Override the default container arguments when in dev mode."),
      command: joi
        .sparseArray()
        .items(joi.string())
        .description("Override the default container command (i.e. entrypoint) when in dev mode."),
      sync: joi
        .array()
        .items(devModeSyncSchema())
        .description(
          "Specify one or more source files or directories to automatically sync with the running container."
        ),
    })
    .description(devModeDescription(false))

export interface KubernetesDevModeSpec extends ContainerDevModeSpec {
  containerName?: string
}

export const kubernetesDevModeSchema = () =>
  containerDevModeSchema()
    .keys({
      containerName: joiIdentifier().description(
        `Optionally specify the name of a specific container to sync to. If not specified, the first container in the workload is used.`
      ),
    })
    .description(devModeDescription(true))

export interface KubernetesDevModeDefaults {
  exclude?: string[]
  fileMode?: number
  directoryMode?: number
  owner?: number | string
  group?: number | string
}

const syncDefaultOwnerSchema = () =>
  joi
    .alternatives(joi.number().integer(), joi.string())
    .description("Set the default owner of files and directories at the target. " + ownerDocs)

const syncDefaultGroupSchema = () =>
  joi
    .alternatives(joi.number().integer(), joi.string())
    .description("Set the default group on files and directories at the target. " + ownerDocs)

export type SyncMode = "one-way" | "one-way-replica" | "one-way-reverse" | "one-way-replica-reverse" | "two-way"

export interface DevModeSyncSpec {
  source: string
  target: string
  mode: SyncMode
  exclude?: string[]
  defaultFileMode?: number
  defaultDirectoryMode?: number
  defaultOwner?: number | string
  defaultGroup?: number | string
}

const permissionsDocs =
  "See the [Mutagen docs](https://mutagen.io/documentation/synchronization/permissions#permissions) for more information."

const ownerDocs =
  "Specify either an integer ID or a string name. See the [Mutagen docs](https://mutagen.io/documentation/synchronization/permissions#owners-and-groups) for more information."

const syncExcludeSchema = () =>
  joi
    .array()
    .items(joi.posixPath().allowGlobs().subPathOnly())
    .description(
      dedent`
        Specify a list of POSIX-style paths or glob patterns that should be excluded from the sync.

        \`.git\` directories and \`.garden\` directories are always ignored.
      `
    )
    .example(["dist/**/*", "*.log"])

const syncDefaultFileModeSchema = () =>
  joi
    .number()
    .min(0)
    .max(0o777)
    .description(
      "The default permission bits, specified as an octal, to set on files at the sync target. Defaults to 0600 (user read/write). " +
        permissionsDocs
    )

const syncDefaultDirectoryModeSchema = () =>
  joi
    .number()
    .min(0)
    .max(0o777)
    .description(
      "The default permission bits, specified as an octal, to set on directories at the sync target. Defaults to 0700 (user read/write). " +
        permissionsDocs
    )
/**
 * Provider-level dev mode settings for the local and remote k8s providers.
 */
export const kubernetesDevModeDefaultsSchema = () =>
  joi.object().keys({
    exclude: syncExcludeSchema().description(dedent`
        Specify a list of POSIX-style paths or glob patterns that should be excluded from the sync.

        Any exclusion patterns defined in individual dev mode sync specs will be applied in addition to these patterns.

        \`.git\` directories and \`.garden\` directories are always ignored.
      `),
    fileMode: syncDefaultFileModeSchema(),
    directoryMode: syncDefaultDirectoryModeSchema(),
    owner: syncDefaultOwnerSchema(),
    group: syncDefaultGroupSchema(),
  }).description(dedent`
    Specifies default settings for dev mode syncs (e.g. for \`container\`, \`kubernetes\` and \`helm\` services).

    These are overridden/extended by the settings of any individual dev mode sync specs for a given module or service.

    Dev mode is enabled when running the \`garden dev\` command, and by setting the \`--dev\` flag on the \`garden deploy\` command.

    See the [Code Synchronization guide](${devModeGuideLink}) for more information.
  `)

/**
 * Configures the specified Deployment, DaemonSet or StatefulSet for dev mode.
 */
export function configureDevMode({ target, spec, containerName }: ConfigureDevModeParams): void {
  set(target, ["metadata", "annotations", gardenAnnotationKey("dev-mode")], "true")
  const mainContainer = getResourceContainer(target, containerName)

  if (spec.command) {
    mainContainer.command = spec.command
  }

  if (spec.args) {
    mainContainer.args = spec.args
  }

  if (!spec.sync.length) {
    return
  }

  const podSpec = getResourcePodSpec(target)

  if (!podSpec) {
    return
  }

  // Inject mutagen agent on init
  const gardenVolumeName = `garden`
  const gardenVolumeMount = {
    name: gardenVolumeName,
    mountPath: "/.garden",
  }

  if (!podSpec.volumes) {
    podSpec.volumes = []
  }

  podSpec.volumes.push({
    name: gardenVolumeName,
    emptyDir: {},
  })

  const initContainer = {
    name: "garden-dev-init",
    image: k8sSyncUtilImageName,
    command: ["/bin/sh", "-c", "cp /usr/local/bin/mutagen-agent " + mutagenAgentPath],
    imagePullPolicy: "IfNotPresent",
    volumeMounts: [gardenVolumeMount],
  }

  if (!podSpec.initContainers) {
    podSpec.initContainers = []
  }
  podSpec.initContainers.push(initContainer)

  if (!mainContainer.volumeMounts) {
    mainContainer.volumeMounts = []
  }

  mainContainer.volumeMounts.push(gardenVolumeMount)
}

interface StartDevModeSyncParams extends ConfigureDevModeParams {
  ctx: PluginContext
  log: LogEntry
  moduleRoot: string
  namespace: string
  serviceName: string
}

export async function startDevModeSync({
  containerName,
  ctx,
  log,
  moduleRoot,
  namespace,
  spec,
  target,
  serviceName,
}: StartDevModeSyncParams) {
  if (spec.sync.length === 0) {
    return
  }
  namespace = target.metadata.namespace || namespace
  const resourceName = `${target.kind}/${target.metadata.name}`
  const keyBase = `${target.kind}--${namespace}--${target.metadata.name}`

  return mutagenConfigLock.acquire("start-sync", async () => {
    // Validate the target
    if (!isConfiguredForDevMode(target)) {
      throw new ConfigurationError(`Resource ${resourceName} is not deployed in dev mode`, {
        target,
      })
    }

    if (!containerName) {
      containerName = getResourcePodSpec(target)?.containers[0]?.name
    }

    if (!containerName) {
      throw new ConfigurationError(`Resource ${resourceName} doesn't have any containers`, {
        target,
      })
    }

    const k8sCtx = <KubernetesPluginContext>ctx
    const k8sProvider = <KubernetesProvider>k8sCtx.provider
    const defaults = k8sProvider.config.devMode?.defaults || {}

    let i = 0

    for (const s of spec.sync) {
      const key = `${keyBase}-${i}`

      const localPath = joinWithPosix(moduleRoot, s.source).replace(/ /g, "\\ ") // Escape spaces in path
      const remoteDestination = await getKubectlExecDestination({
        ctx: k8sCtx,
        log,
        namespace,
        containerName,
        resourceName: `${target.kind}/${target.metadata.name}`,
        targetPath: s.target,
      })

      const localPathDescription = chalk.white(s.source)
      const remoteDestinationDescription = `${chalk.white(s.target)} in ${chalk.white(resourceName)}`
      let sourceDescription: string
      let targetDescription: string
      if (isReverseMode(s.mode)) {
        sourceDescription = remoteDestinationDescription
        targetDescription = localPathDescription
      } else {
        sourceDescription = localPathDescription
        targetDescription = remoteDestinationDescription
      }

      const description = `${sourceDescription} to ${targetDescription}`

      log.info({ symbol: "info", section: serviceName, msg: chalk.gray(`Syncing ${description} (${s.mode})`) })

      await ensureMutagenSync({
        ctx,
        // Prefer to log to the main view instead of the handler log context
        log,
        key,
        logSection: serviceName,
        sourceDescription,
        targetDescription,
        config: makeSyncConfig({ defaults, spec: s, localPath, remoteDestination }),
      })

      i++
    }
  })
}

export function makeSyncConfig({
  localPath,
  remoteDestination,
  defaults,
  spec,
}: {
  localPath: string
  remoteDestination: string
  defaults: KubernetesDevModeDefaults | null
  spec: DevModeSyncSpec
}): SyncConfig {
  const s = spec
  const d = defaults || {}
  const reverse = isReverseMode(s.mode)
  return {
    alpha: reverse ? remoteDestination : localPath,
    beta: reverse ? localPath : remoteDestination,
    mode: s.mode,
    ignore: [...builtInExcludes, ...(d["exclude"] || []), ...(s.exclude || [])],
    defaultOwner: s.defaultOwner === undefined ? d["owner"] : s.defaultOwner,
    defaultGroup: s.defaultGroup === undefined ? d["group"] : s.defaultGroup,
    defaultDirectoryMode: s.defaultDirectoryMode === undefined ? d["directoryMode"] : s.defaultDirectoryMode,
    defaultFileMode: s.defaultFileMode === undefined ? d["fileMode"] : s.defaultFileMode,
  }
}

const isReverseMode = (mode: string) => mode === "one-way-reverse" || mode === "one-way-replica-reverse"
