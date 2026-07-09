import React, { createContext, useContext, useState } from 'react'

type SearchCtx = { query: string; setQuery: (v: string) => void }

const Ctx = createContext<SearchCtx | null>(null)

/** Глобальный поиск — общий для верхней панели и активного раздела. */
export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState('')
  return <Ctx.Provider value={{ query, setQuery }}>{children}</Ctx.Provider>
}

export function useSearch(): SearchCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSearch must be used within SearchProvider')
  return ctx
}
