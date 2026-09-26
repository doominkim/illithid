import { TextInput } from '@mantine/core'
import { Search } from 'lucide-react'

export function SearchInput({
  value,
  onChange,
  placeholder,
  w = 280
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  w?: number | string
}): React.JSX.Element {
  return (
    <TextInput
      w={w}
      leftSection={<Search size={14} />}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  )
}
