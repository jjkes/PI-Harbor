/** Remote-first install with one verified SSH-upload fallback, never tool replay. */
import { buildBootstrapScript, parseBootstrapOutput, type PiHostBootstrapScriptInput } from "./pi-host-bootstrap-script.js";
import { uploadSshArtifact } from "./ssh-artifact-transfer.js";
import type { SshExecResult, SshTransport } from "./ssh-transport.js";

export async function installPiHost(
  transport: SshTransport,
  input: PiHostBootstrapScriptInput,
  options: {
    timeoutMs: number; signal?: AbortSignal;
    uploadArtifact?: typeof uploadSshArtifact;
    /**
     * Send these local bytes instead of letting the remote download the URL.
     * Used when the release publishes no artifact for this target, e.g. a local
     * build the user points the desktop at.
     */
    localArtifactPath?: string;
    /** Skip the remote download attempt and upload straight away. */
    preferUpload?: boolean;
    onUpload?: () => void;
    log?: (level: "warn", message: string) => void;
  },
): Promise<SshExecResult> {
  const run = async (artifactPath?: string) => {
    options.signal?.throwIfAborted();
    const result = await transport.execWithInput("sh -s", buildBootstrapScript({ ...input, artifactPath }),
      { timeoutMs: options.timeoutMs, maxOutputBytes: 64 * 1024 });
    options.signal?.throwIfAborted();
    return result;
  };
  let initial: SshExecResult | undefined;
  if (!options.preferUpload) {
    try {
      initial = await run();
      if (parseBootstrapOutput(initial.stdout).failure !== "download-failed") return initial;
    } catch (error) {
      options.signal?.throwIfAborted();
      const step = parseBootstrapOutput(String((error as { stdout?: unknown })?.stdout ?? "")).failure;
      if (step !== "download-failed") throw error;
      initial = { stdout: String((error as { stdout?: unknown }).stdout ?? ""), stderr: "", code: 1 };
    }
  }
  if (!transport.execWithFile && !options.uploadArtifact) {
    // A caller that forced the upload has no earlier result to report, and one
    // that could not download has nothing better than what the remote said.
    if (!initial) throw new Error("this SSH transport cannot upload an artifact");
    return initial;
  }
  options.signal?.throwIfAborted();
  options.onUpload?.();
  const artifact = await (options.uploadArtifact ?? uploadSshArtifact)(transport, {
    url: input.artifactUrl,
    expectedSha256: input.expectedSha256,
    signal: options.signal,
    ...(options.localArtifactPath ? { sourcePath: options.localArtifactPath } : {}),
  });
  try { return await run(artifact.path); }
  finally {
    try { await artifact.cleanup(); }
    catch { options.log?.("warn", "SSH artifact temporary directory cleanup failed"); }
  }
}
