import { X } from 'lucide-react';
import type { MapData, MapPreference } from '../../../../contracts/ts/ipc.gen';
import { SearchInput } from '../../components/SearchInput';
import { useLocale } from '../../hooks/useLocale';

type Props = {
  tasks: MapData['tasks'];
  preference: MapPreference;
  taskQuery: string;
  setTaskQuery: (query: string) => void;
  onPreference: (changes: Partial<MapPreference>) => void;
  onClose: () => void;
};

export function TaskPanel({
  tasks,
  preference,
  taskQuery,
  setTaskQuery,
  onPreference,
  onClose,
}: Props) {
  const { t } = useLocale();
  return (
    <>
      <div className="panel-title">
        <span>{t('map.tasks.trigger')}</span>
        <div className="panel-actions">
          <button
            className="all-tasks"
            onClick={() =>
              onPreference({
                taskFilterActive: false,
                selectedTasks: [],
              })
            }
          >
            {t('map.tasks.all')}
          </button>
          <button
            className="all-tasks"
            onClick={() =>
              onPreference({
                taskFilterActive: true,
                selectedTasks: [],
              })
            }
          >
            {t('map.tasks.none')}
          </button>
          <button
            className="icon-button"
            aria-label={t('map.tasks.close')}
            onClick={() => onClose()}
          >
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="panel-scroll">
        <div className="task-search">
          <SearchInput
            value={taskQuery}
            onChange={setTaskQuery}
            placeholder={t('map.tasks.search')}
            label={t('map.tasks.search')}
            clearLabel={t('map.tasks.clearSearch')}
          />
        </div>
        {tasks.length > 0 &&
          !tasks.some((task) =>
            task.name.toLocaleLowerCase().includes(taskQuery.trim().toLocaleLowerCase()),
          ) && <p className="hint">{t('map.tasks.noMatch')}</p>}
        {tasks.length ? (
          tasks
            .filter((task) =>
              task.name.toLocaleLowerCase().includes(taskQuery.trim().toLocaleLowerCase()),
            )
            .map((task) => (
              <label className="check-row" key={task.id}>
                <input
                  type="checkbox"
                  checked={
                    !preference.taskFilterActive || preference.selectedTasks.includes(task.id)
                  }
                  onChange={() =>
                    onPreference({
                      taskFilterActive: true,
                      selectedTasks: !preference.taskFilterActive
                        ? tasks.filter((t) => t.id !== task.id).map((t) => t.id)
                        : preference.selectedTasks.includes(task.id)
                          ? preference.selectedTasks.filter((t) => t !== task.id)
                          : [...preference.selectedTasks, task.id],
                    })
                  }
                />
                {task.name}
              </label>
            ))
        ) : (
          <p className="hint">{t('map.tasks.empty')}</p>
        )}
      </div>
    </>
  );
}
