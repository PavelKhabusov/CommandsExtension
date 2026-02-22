#!/bin/bash
frases=(
  "Tarea completada"
  "Listo, todo hecho"
  "Misión cumplida"
  "Ya está, terminé"
  "Trabajo terminado"
  "Hecho y listo"
  "Todo en orden"
  "Asunto resuelto"
)
say -v Paulina "${frases[$((RANDOM % ${#frases[@]}))]}"

npm run test-ext