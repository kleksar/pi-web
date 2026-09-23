import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildAgentResourceCatalog, type AgentResourceCatalog } from "./agent-resource-catalog";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { getRepositorySkillPaths } from "./repository-roster";

export async function loadAgentResourceCatalog(cwd: string): Promise<AgentResourceCatalog> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({ cwd, agentDir, additionalSkillPaths: getRepositorySkillPaths() });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  const { extensions, errors } = loader.getExtensions();
  return {
    ...buildAgentResourceCatalog(skills, extensions),
    diagnostics,
    extensionErrors: errors,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
