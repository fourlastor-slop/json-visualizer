import { useEffect } from 'react';
import { loadAll, useAppState } from './data/store';
import { useRoute } from './lib/router';
import { syncMcp } from './mcp/state';
import { EditorPage } from './pages/EditorPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { Shell } from './pages/Shell';
import { TemplatesPage } from './pages/TemplatesPage';
import { ViewPage } from './pages/ViewPage';
import { EmptyState } from './ui/controls';
import { Feedback } from './ui/feedback';

function Page() {
  const route = useRoute();
  switch (route.page) {
    case 'project':
      return <ProjectPage key={route.projectId} projectId={route.projectId} />;
    case 'editor':
      return <EditorPage key={route.vizId} projectId={route.projectId} vizId={route.vizId} />;
    case 'view':
      return <ViewPage key={route.vizId} projectId={route.projectId} vizId={route.vizId} table={route.table} />;
    case 'templates':
      return <TemplatesPage />;
    default:
      return <ProjectsPage />;
  }
}

export function App() {
  const state = useAppState();

  useEffect(() => {
    // MCP clients are served once there is something to serve them from.
    void loadAll().then(syncMcp);
  }, []);

  if (!state.ready) return null;
  if (state.failure) {
    return (
      <Shell>
        <EmptyState icon="alert" title="Browser storage is not available">
          JSON Explorer keeps everything in this browser’s storage, and could not open it: {state.failure} Private windows and some privacy settings block it.
        </EmptyState>
      </Shell>
    );
  }
  return (
    <>
      <Page />
      <Feedback />
    </>
  );
}
