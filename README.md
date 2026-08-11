# Stereo Depth Estimation from Synthetic Data

**Project by Hanan Dann and Niv Noach**

This project explores depth estimation from **stereoscopic image pairs** using neural networks.

The repository contains everything needed to generate synthetic stereoscopic datasets from 3D `.stl` models, train depth-estimation models, and evaluate their performance.

## Project Contents

The repository includes:

* **Synthetic dataset generator** (`synthetic` folder) — a tool for generating stereoscopic image pairs from `.stl` files.
* **Sample datasets** (`stl_data` folder) — pre-generated datasets.
* **Training & evaluation notebook** (`depth.ipynb`) — a Jupyter Notebook (`.ipynb`) for training the model and visualizing its evaluation results.

## Repository Structure

```text
.
├── stl_data/
│   ├── ...
│   └── <dataset>.csv
├── <dataset-generator-files>
├── <training-notebook>.ipynb
└── README.md
```

## Getting Started

### 1. Clone the repository

```bash
git clone <repository-url>
cd <repository-directory>
```

### 2. Open the Jupyter Notebook

Open the training and evaluation notebook:

```bash
jupyter notebook
```

Then open the `.ipynb` file in the repository.

---

# Training the Model

The notebook is designed to run from beginning to end with minimal configuration.

### Step 1 — Configure the parameters

**Before running the notebook**, open the **second cell** and adjust the configuration parameters.

The main parameters are:

| Parameter       | Description                                           |
| --------------- | ----------------------------------------------------- |
| `dataset_file`  | Path to the `.csv` file describing the dataset to use |
| `IMAGE_SIZE`    | Image dimensions used by the dataset                  |
| `LEARNING_RATE` | Learning rate used by the optimizer                   |
| `MODEL`         | Neural network architecture to train                  |

### `dataset_file`

Select one of the pre-computed datasets located under the `stl_data` folder.

The parameter should point to the dataset's `.csv` file.

For example:

```python
dataset_file = "stl_data/<dataset>/<dataset>.csv"
```

The CSV contains the information required to load the stereoscopic image pairs and their corresponding ground-truth depth information.

### `IMAGE_SIZE`

Specifies the size of each image in the dataset.

For example:

```python
IMAGE_SIZE = (256, 256)
```

**Important:** `IMAGE_SIZE` must match the actual image dimensions of **all images in the selected dataset**.

Using a different value will cause the notebook to fail when loading or processing the images.

### `LEARNING_RATE`

Controls the learning rate used by the optimizer.

For example:

```python
LEARNING_RATE = 10e-3
```

Adjust this value depending on the selected model and training behavior.

### `MODEL`

Selects the neural network architecture to train.

There are **three models** available.

See the **Models** section below for a description of each architecture.

For example:

```python
MODEL = "model_name"
```

---

# Running the Notebook

Once the parameters in the second cell have been configured:

1. Open the Jupyter Notebook.
2. Adjust the parameters in the **second cell**.
3. Verify that `dataset_file` points to the desired dataset.
4. Verify that `IMAGE_SIZE` matches the dataset.
5. Select the desired `LEARNING_RATE`.
6. Select one of the available `MODEL` architectures.
7. **Run the entire notebook from beginning to end.**

The notebook will:

1. Load the selected dataset.
2. Prepare the stereoscopic image pairs and ground-truth data.
3. Build the selected neural network.
4. Train the model.
5. Evaluate the trained model.
6. Generate visualizations of the evaluation results.

The visualizations provide a qualitative view of how well the model is able to estimate depth from the stereoscopic image pairs.

---

# Synthetic Dataset Generation

The repository also contains a tool for generating synthetic datasets from `.stl` files.

The general workflow is:

TODO

---

# Models

The project includes three different neural network architectures for stereo depth estimation.

Detailed documentation for the three models can be found here:

> **TODO:** Add documentation describing the three available models.

| Model            | Description |
| ---------------- | ----------- |
| naive            | CNN layers (with MaxPooling) for both images together, followed by dense layers for depth forecasting        |
| stereo_branches  | similar to "naive", but with separate convolutional layers for each image, later merged into dense layers    |
| double_resnet    | Two ResNet networks, one for each image (left/right), and then dense layers processing only the diff and correlation between the two ResNet outputs        |

The model can be selected setting the `MODEL` parameter in the notebook's second cell.

---

# Dataset

A sample set of pre-computed datasets is included in the `stl_data` directory.

Each dataset contains stereoscopic image pairs generated from `.stl` models, together with the corresponding ground-truth information required for training and evaluation.

This allows the same training pipeline to be used across multiple datasets.

---

# Authors

**Hanan Dann**
**Niv Noach**

---

# License

This project is licensed under the **MIT License**.

Copyright (c) 2026 Hanan Dann and Niv Noach

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
