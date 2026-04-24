const moodSelect = document.getElementById('mood');
const getRecipeBtn = document.getElementById('getRecipe');
const recipeBox = document.getElementById('recipeBox');
const recipeTitle = document.getElementById('recipeTitle');
const recipeDesc = document.getElementById('recipeDesc');
const newRecipeBtn = document.getElementById('newRecipe');
const errorBox = document.getElementById('errorBox');

let currentRecipe = null;
let currentMood = '';

function showRecipe(recipe) {
  recipeTitle.textContent = recipe.title;
  recipeDesc.textContent = recipe.description;
  recipeBox.classList.remove('hidden');
  errorBox.classList.add('hidden');
  currentRecipe = recipe;
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
  recipeBox.classList.add('hidden');
}

getRecipeBtn.addEventListener('click', async () => {
  const mood = moodSelect.value;
  if (!mood) {
    showError('Please select a mood.');
    return;
  }
  try {
    const res = await fetch(`http://localhost:3001/api/recipe/${mood}`);
    if (!res.ok) throw new Error('No recipe found for this mood.');
    const recipe = await res.json();
    currentMood = mood;
    showRecipe(recipe);
  } catch (err) {
    showError(err.message);
  }
});

newRecipeBtn.addEventListener('click', async () => {
  if (!currentMood || !currentRecipe) return;
  try {
    const res = await fetch(`http://localhost:3001/api/recipe/${currentMood}/new/${currentRecipe.id}`);
    if (!res.ok) throw new Error('No more recipes found for this mood.');
    const recipe = await res.json();
    showRecipe(recipe);
  } catch (err) {
    showError(err.message);
  }
}); 