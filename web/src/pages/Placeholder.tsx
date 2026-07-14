import { Construction } from 'lucide-react'
import { EmptyState } from '@/components/ui/page'

export function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<Construction />}
        title={title}
        description="Coming in a future phase"
      />
    </div>
  )
}
