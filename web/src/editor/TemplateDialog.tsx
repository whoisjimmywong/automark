import { useState } from 'react';
import type { AMF } from '../../../shared/amf.types';

/** 试卷/模板/答题卡设置弹窗 */
export default function TemplateDialog({
  amf,
  onClose,
  onMutate,
}: {
  amf: AMF;
  onClose: () => void;
  onMutate: (amf: AMF) => void;
}) {
  const [draft, setDraft] = useState<AMF>(() => JSON.parse(JSON.stringify(amf)) as AMF);
  const t = draft.paper.template;
  const cfg = draft.answer_sheet_config ?? {};
  const markers = cfg.markers ?? { corners: true, qr: true, barcode: false };
  const modeA = draft.paper.mode === 'answer_sheet';

  const patchExam = (p: Partial<AMF['exam']>) => setDraft({ ...draft, exam: { ...draft.exam, ...p } });
  const patchTpl = (p: Partial<typeof t>) =>
    setDraft({ ...draft, paper: { ...draft.paper, template: { ...t, ...p } } });
  const patchCfg = (p: Partial<NonNullable<AMF['answer_sheet_config']>>) =>
    setDraft({ ...draft, answer_sheet_config: { ...cfg, ...p } });

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>试卷设置</h2>

        <div className="row">
          <div>
            <label>考试标题</label>
            <input value={draft.exam.title} onChange={(e) => patchExam({ title: e.target.value })} />
          </div>
          <div>
            <label>学科</label>
            <input value={draft.exam.subject} onChange={(e) => patchExam({ subject: e.target.value })} />
          </div>
        </div>
        <div className="row">
          <div>
            <label>年级</label>
            <input value={draft.exam.grade ?? ''} onChange={(e) => patchExam({ grade: e.target.value })} />
          </div>
          <div>
            <label>时长（分钟）</label>
            <input
              type="number"
              min={1}
              value={draft.exam.duration_min ?? ''}
              onChange={(e) => patchExam({ duration_min: Number(e.target.value) || undefined })}
            />
          </div>
        </div>

        <label>作答方式</label>
        <select
          value={draft.paper.mode}
          onChange={(e) => {
            const mode = e.target.value as 'answer_sheet' | 'on_paper';
            setDraft({
              ...draft,
              paper: { ...draft.paper, mode },
              ...(mode === 'answer_sheet' && !draft.answer_sheet_config
                ? {
                    answer_sheet_config: {
                      page_size: 'A4', orientation: 'portrait', mark_style: 'ellipse',
                      bubble_size_mm: 3, bubble_pitch_mm: 8,
                      student_id: { kind: 'bubble', digits: 12 },
                      markers: { corners: true, qr: true, barcode: false },
                      absent_mark: true,
                    },
                  }
                : {}),
            });
          }}
        >
          <option value="answer_sheet">模式 A：标准化答题卡作答</option>
          <option value="on_paper">模式 B：直接在试卷上作答</option>
        </select>

        <label>试卷副标题</label>
        <input value={t.subtitle ?? ''} onChange={(e) => patchTpl({ subtitle: e.target.value })} placeholder="如 Time: 40 min    Full score: 25" />
        <label>注意事项 / 考试说明</label>
        <textarea rows={2} value={t.instructions ?? ''} onChange={(e) => patchTpl({ instructions: e.target.value })} />
        <label>页脚模板（{'{page}'} / {'{pages}'} 占位符）</label>
        <input value={t.footer ?? ''} onChange={(e) => patchTpl({ footer: e.target.value })} />
        <div className="checkbox-line">
          <input type="checkbox" id="cb_name" checked={t.header?.show_name ?? true}
            onChange={(e) => patchTpl({ header: { ...t.header, show_name: e.target.checked } })} />
          <span>试卷显示姓名栏</span>
        </div>

        {modeA && (
          <>
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />
            <h2 style={{ fontSize: 14 }}>答题卡</h2>
            <div className="row">
              <div>
                <label>学号位数</label>
                <input type="number" min={3} max={12} value={cfg.student_id?.digits ?? 12}
                  onChange={(e) => patchCfg({ student_id: { kind: 'bubble', digits: Math.max(3, Math.min(12, Number(e.target.value) || 12)) } })} />
              </div>
              <div>
                <label>气泡直径 (mm)</label>
                <input type="number" min={2} max={8} step={0.5} value={cfg.bubble_size_mm ?? 3}
                  onChange={(e) => patchCfg({ bubble_size_mm: Number(e.target.value) || 3 })} />
              </div>
              <div>
                <label>气泡间距 (mm)</label>
                <input type="number" min={5} max={15} step={0.5} value={cfg.bubble_pitch_mm ?? 8}
                  onChange={(e) => patchCfg({ bubble_pitch_mm: Number(e.target.value) || 8 })} />
              </div>
            </div>
            <label>判断题标签（逗号分隔，如 T,F 或 对,错）</label>
            <input
              value={(cfg.tf_labels ?? ['T', 'F']).join(',')}
              onChange={(e) => {
                const parts = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                if (parts.length === 2) patchCfg({ tf_labels: [parts[0], parts[1]] });
              }}
            />
            <label>页脚印刷说明</label>
            <input value={cfg.footer_note ?? ''} placeholder="Use a pencil. Rub out any answer…"
              onChange={(e) => patchCfg({ footer_note: e.target.value })} />
            <div className="checkbox-line">
              <input type="checkbox" checked={markers.corners ?? true}
                onChange={(e) => patchCfg({ markers: { ...markers, corners: e.target.checked } })} />
              <span>四角 L 型定位标</span>
              <input type="checkbox" checked={markers.qr ?? true} style={{ marginLeft: 16 }}
                onChange={(e) => patchCfg({ markers: { ...markers, qr: e.target.checked } })} />
              <span>页码二维码</span>
            </div>
            <div className="checkbox-line">
              <input type="checkbox" checked={cfg.absent_mark ?? true}
                onChange={(e) => patchCfg({ absent_mark: e.target.checked })} />
              <span>缺考/异常标记（ABSENT/WITHDRAWN 填涂圈）</span>
            </div>
          </>
        )}

        <div className="actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => onMutate(draft)}>应用</button>
        </div>
      </div>
    </div>
  );
}
