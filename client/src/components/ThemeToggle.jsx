import { useTheme } from '../context/ThemeContext'
import { MoonIcon, SunIcon } from './Icons'

export default function ThemeToggle({ className = '' }) {
  const { theme, toggleTheme } = useTheme()

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`inline-flex items-center justify-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface-subtle)] p-2 text-[var(--text-muted)] transition-all hover:border-[var(--accent)] hover:text-[var(--text-main)] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${className}`}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? (
        <SunIcon className="h-4 w-4 text-amber-400" />
      ) : (
        <MoonIcon className="h-4 w-4" />
      )}
    </button>
  )
}
