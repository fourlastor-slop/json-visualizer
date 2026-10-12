/** What the editor and the full-screen view show for a visualization that is not there. */
import type { Project } from '../data/types';
import { hrefFor } from '../lib/router';
import { EmptyState } from '../ui/controls';
import { Shell } from './Shell';

export function VizNotFound({ project }: { project: Project | undefined }) {
  return (
    <Shell crumbs={[{ label: 'Not found' }]}>
      <EmptyState
        icon="line"
        title="This visualization does not exist"
        action={
          <a className="button" href={project ? hrefFor({ page: 'project', projectId: project.id }) : hrefFor({ page: 'projects' })}>
            {project ? `Back to ${project.name}` : 'All projects'}
          </a>
        }
      >
        It may have been deleted.
      </EmptyState>
    </Shell>
  );
}
