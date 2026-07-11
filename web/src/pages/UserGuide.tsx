// [XJC] Illustrated offline guide: the same HTML and screenshots ship with portable builds.
import { Button } from '@/components/ui/button'
import { WindowsTitleBar } from '@/components/layout/WindowsTitleBar'
import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

const GUIDE_URL = `${import.meta.env.BASE_URL}user-guide/index.html`

export function UserGuide({ standalone = false }: { standalone?: boolean }) {
  const navigate = useNavigate()

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {standalone && <WindowsTitleBar />}
      {standalone && (
        <div className="flex h-12 shrink-0 items-center border-b bg-background px-4">
          <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate('/login')}>
            <ArrowLeft className="h-3.5 w-3.5" />
            返回登录
          </Button>
        </div>
      )}
      <iframe
        data-testid="guide-page"
        title="XiaoJuClaw 图文操作手册"
        src={GUIDE_URL}
        sandbox="allow-scripts allow-modals"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  )
}
