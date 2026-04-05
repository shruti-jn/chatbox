import { useMantineTheme } from '@mantine/core'
import type { IconProps } from '@tabler/icons-react'
import { forwardRef } from 'react'

type Props = Omit<IconProps, 'size'> & {
  size?: number
  icon: React.ElementType<IconProps>
}

function ScalableIconInner({ icon: IconComponent, size = 16, ...others }: Props) {
  const theme = useMantineTheme()
  const scale = theme.scale ?? 1
  return <IconComponent size={size * scale} {...others} />
}

export const ScalableIcon = forwardRef(ScalableIconInner)
